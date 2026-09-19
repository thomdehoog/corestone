package foundation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// View is an artifact as the API returns it: projected metadata plus the
// authoritative document read from Git.
type View struct {
	Meta        *model.Summary          `json:"meta"`
	Data        *ojson.Object           `json:"data"`
	ETag        string                  `json:"etag"`
	Attachments []projection.Attachment `json:"attachments,omitempty"`
}

func summarize(a *model.Artifact, folder, path, etag string) *model.Summary {
	s := &model.Summary{GUID: a.GUID, Kind: a.Kind, Type: a.Type, Title: a.Title, HID: a.HID, Folder: folder, Path: path,
		Base: a.Base, Source: a.Source, Target: a.Target, Subject: a.Subject, Parent: a.Parent, Author: a.Author,
		Created: a.Created, Workflows: a.Workflows, ETag: etag}
	if a.Fields != nil {
		if m, ok := ojson.ToPlain(a.Fields).(map[string]any); ok {
			s.Fields = m
		}
	}
	return s
}

// CreateArtifact creates an entry or document from a request document with
// the properties path, type, title, hid, base, fields and content.
func (f *Foundation) CreateArtifact(ctx context.Context, kind model.Kind, req *ojson.Object) (*View, error) {
	if !kind.IsFolderKind() {
		return nil, model.Invalid("kind %s is created through its own endpoint", kind)
	}
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		folder, err := model.CleanFolder(req.String("path"))
		if err != nil {
			return nil, err
		}
		typ := strings.TrimSpace(req.String("type"))
		guid := model.NewGUID()
		doc := model.NewDoc(kind, guid, typ)
		doc.Set("title", strings.TrimSpace(req.String("title")))
		if h := req.String("hid"); h != "" {
			doc.Set("hid", strings.TrimSpace(h))
		}
		if b := req.String("base"); b != "" {
			doc.Set("base", strings.ToLower(strings.TrimSpace(b)))
		}
		fields := req.Object("fields")
		if fields == nil {
			fields = ojson.NewObject()
		}
		doc.Set("fields", fields.Clone())
		doc.Set("workflows", ojson.NewObject())
		if kind == model.KindDocument {
			content := req.Array("content")
			if content == nil {
				content = []any{}
			}
			doc.Set("content", ojson.Clone(content))
		}
		a, err := model.ArtifactFromDoc(doc, kind)
		if err != nil {
			return nil, err
		}
		if err := t.validateArtifact(a, folder, nil, true); err != nil {
			return nil, err
		}
		content := encode(doc, ojson.DefaultStyle)
		path := model.ArtifactDir(folder, guid) + "/" + model.GUIDFile
		cs := &changeset{subject: fmt.Sprintf("%s %s in %s created", kindName(kind), label(a), folderName(folder))}
		cs.trailer("Corestone-Op", "create")
		cs.trailer("Corestone-Guid", guid)
		cs.trailer("Corestone-Kind", string(kind))
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "create", GUID: guid, Kind: string(kind)}
		cs.result = &View{Meta: summarize(a, folder, path, gitx.BlobSHA(content)), Data: doc, ETag: gitx.BlobSHA(content)}
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*View), nil
}

// validateArtifact enforces the repository contract for an entry or
// document: type, HID uniqueness, overlay acyclicity, field types,
// required fields, reference integrity, document content and workflow
// initialization (states for newly assigned workflows are filled in).
func (t *txn) validateArtifact(a *model.Artifact, folder string, previous *model.Artifact, isNew bool) error {
	if err := a.Validate(); err != nil {
		return err
	}
	eff := t.schemas.Effective(a.Type, folder)
	if eff != nil && eff.Kind != a.Kind {
		return model.Invalid("type %q describes %ss, not %ss", a.Type, eff.Kind, a.Kind)
	}
	// HID: generate or check uniqueness.
	if a.HID == "" && isNew && eff != nil && eff.HID != nil {
		hid, err := t.generateHID(eff.HID)
		if err != nil {
			return err
		}
		a.HID = hid
		a.Doc.Set("hid", hid)
	}
	if a.HID != "" && (previous == nil || previous.HID != a.HID) {
		owner, err := t.f.DB.HIDOwner(t.ctx, a.HID)
		if err != nil {
			return err
		}
		if owner != "" && owner != a.GUID {
			return fmt.Errorf("%w: HID %s is already used by %s", model.ErrConflict, a.HID, owner)
		}
	}
	// Overlay chain.
	resolved := a.Fields
	if a.Base != "" {
		if _, err := t.exists(a.Base, model.KindEntry); err != nil {
			return err
		}
		ov, err := model.ResolveOverlay(a, func(g string) (*model.Artifact, error) {
			l, err := t.load(g)
			if err != nil {
				return nil, err
			}
			return l.Artifact, nil
		})
		if err != nil {
			return err
		}
		resolved = ov.Fields
	}
	// Anything deriving from this entry must not create a cycle when the
	// base changes: ResolveOverlay above walks upwards; downward cycles are
	// impossible because a base can only point at existing entries and the
	// existing chain was acyclic.
	if eff != nil {
		if err := t.validateFields(eff, a.Fields, resolved); err != nil {
			return err
		}
	} else if a.Fields != nil {
		// Untyped: still verify that GUID-shaped values resolve.
		for _, k := range a.Fields.Keys() {
			v, _ := a.Fields.Get(k)
			if s, ok := v.(string); ok && model.IsGUID(s) {
				if _, err := t.exists(s); err != nil {
					return fmt.Errorf("field %q: %w", k, err)
				}
			}
		}
	}
	if a.Kind == model.KindDocument {
		for _, ref := range model.ContentRefs(a.Content) {
			if _, err := t.exists(ref, model.KindEntry, model.KindDocument); err != nil {
				return fmt.Errorf("document content: %w", err)
			}
		}
	}
	// Workflows: initialize states of assigned workflows that have none yet.
	if eff != nil {
		for _, wid := range eff.AllWorkflows() {
			if _, has := a.Workflows[wid]; has {
				continue
			}
			def := t.workflows.Resolve(wid, folder)
			if def == nil {
				return model.Invalid("schema %q assigns workflow %q which is not defined at %s", a.Type, wid, folderName(folder))
			}
			a.SetWorkflowState(wid, def.Initial)
		}
		for wid, st := range a.Workflows {
			if def := t.workflows.Resolve(wid, folder); def != nil && !def.HasState(st) {
				return model.Invalid("workflow %q has no state %q", wid, st)
			}
		}
	}
	return nil
}

func (t *txn) validateFields(eff *model.Schema, own, resolved *ojson.Object) error {
	if own != nil {
		for _, k := range own.Keys() {
			v, _ := own.Get(k)
			def := eff.Field(k)
			if def == nil {
				continue // unknown fields are allowed: applications and extensions may add properties
			}
			if err := def.ValidateValue(v); err != nil {
				return err
			}
			for _, g := range def.ReferencedGUIDs(v) {
				if _, err := t.exists(g); err != nil {
					return fmt.Errorf("field %q: %w", k, err)
				}
			}
		}
	}
	for _, def := range eff.Fields {
		if !def.Required {
			continue
		}
		var v any
		if resolved != nil {
			v, _ = resolved.Get(def.ID)
		}
		if v == nil || v == "" {
			return model.Invalid("field %q is required", def.ID)
		}
	}
	return nil
}

func (t *txn) generateHID(cfg *model.HIDConfig) (string, error) {
	sep := cfg.Separator
	if sep == "" && cfg.Prefix != "" {
		sep = "-"
	}
	prefix := cfg.Prefix + sep
	n, err := t.f.DB.NextHIDNumber(t.ctx, prefix)
	if err != nil {
		return "", err
	}
	// Also skip HIDs staged in this transaction or taken by a foreign push.
	for i := 0; i < 1000; i++ {
		num := strconv.Itoa(n + i)
		if cfg.Digits > 0 && len(num) < cfg.Digits {
			num = strings.Repeat("0", cfg.Digits-len(num)) + num
		}
		hid := prefix + num
		owner, err := t.f.DB.HIDOwner(t.ctx, hid)
		if err != nil {
			return "", err
		}
		if owner == "" {
			return hid, nil
		}
	}
	return "", fmt.Errorf("%w: could not allocate a HID with prefix %s", model.ErrConflict, prefix)
}

// UpdateArtifact applies a patch document to an artifact of any kind.
// Present properties replace stored ones; null removes hid/base/anchor;
// "fields" is merged key by key (null deletes a field); "content" and
// "text" replace. ifMatch is the expected ETag ("" or "*" to skip).
func (f *Foundation) UpdateArtifact(ctx context.Context, guid string, ifMatch string, patch *ojson.Object) (*View, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if err := checkETag(ifMatch, cur.ETag); err != nil {
			return nil, err
		}
		doc := cur.Doc.Clone()
		for _, k := range patch.Keys() {
			v, _ := patch.Get(k)
			switch k {
			case "title", "hid", "base", "type", "text", "author", "anchor":
				if v == nil || v == "" {
					doc.Delete(k)
				} else {
					if s, ok := v.(string); ok {
						v = strings.TrimSpace(s)
					}
					doc.Set(k, v)
				}
			case "fields":
				pf, _ := v.(*ojson.Object)
				if pf == nil {
					continue
				}
				fields := doc.Object("fields")
				if fields == nil {
					fields = ojson.NewObject()
					doc.Set("fields", fields)
				}
				for _, fk := range pf.Keys() {
					fv, _ := pf.Get(fk)
					if fv == nil {
						fields.Delete(fk)
					} else {
						fields.Set(fk, ojson.Clone(fv))
					}
				}
			case "content":
				if arr, ok := v.([]any); ok {
					doc.Set("content", ojson.Clone(arr))
				}
			case "workflows":
				return nil, model.Invalid("workflow states change through transitions")
			case "guid", "kind":
				if v != doc.String(k) {
					return nil, model.Invalid("%s is immutable", k)
				}
			default:
				doc.Set(k, ojson.Clone(v)) // application-level properties pass through
			}
		}
		a, err := model.ArtifactFromDoc(doc, cur.Kind)
		if err != nil {
			return nil, err
		}
		if a.Kind != cur.Kind {
			return nil, model.Invalid("kind is immutable")
		}
		switch a.Kind {
		case model.KindEntry, model.KindDocument:
			if err := t.validateArtifact(a, cur.Loc.Folder, cur.Artifact, false); err != nil {
				return nil, err
			}
		case model.KindLink:
			if a.Source != cur.Source || a.Target != cur.Target || a.Type != cur.Type {
				return nil, model.Invalid("link endpoints and type are immutable; create a new link instead")
			}
			if err := t.validateLinkFields(a, cur.Loc.Folder); err != nil {
				return nil, err
			}
		case model.KindComment:
			if a.Subject != cur.Subject || a.Parent != cur.Parent {
				return nil, model.Invalid("comment subject and parent are immutable")
			}
			if err := a.Validate(); err != nil {
				return nil, err
			}
			if err := t.validateTyped(a, cur.Loc.Folder); err != nil {
				return nil, err
			}
		}
		content := encode(doc, cur.Style)
		view := &View{Meta: summarize(a, cur.Loc.Folder, cur.Loc.FilePath, gitx.BlobSHA(content)), Data: doc, ETag: gitx.BlobSHA(content)}
		if bytes.Equal(content, cur.Bytes) {
			return &changeset{result: view}, nil // no logical change: no commit
		}
		cs := &changeset{subject: fmt.Sprintf("%s %s modified", kindName(a.Kind), label(a))}
		cs.trailer("Corestone-Op", "update")
		cs.trailer("Corestone-Guid", guid)
		if cur.HID != a.HID {
			cs.subject = fmt.Sprintf("%s %s renamed to %s", kindName(a.Kind), label(cur.Artifact), label(a))
			cs.trailer("Corestone-Hid-Previous", cur.HID)
		}
		cs.ops = []gitx.Op{{Path: cur.Loc.FilePath, Content: content}}
		cs.event = Event{Op: "update", GUID: guid, Kind: string(a.Kind), Subject: a.Subject}
		cs.result = view
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*View), nil
}

// DeleteArtifact removes an artifact of any kind together with the links
// and comments attached to it (and replies to those comments), and every
// file in its GUID directory, in one commit.
func (f *Foundation) DeleteArtifact(ctx context.Context, guid string, ifMatch string) error {
	_, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if err := checkETag(ifMatch, cur.ETag); err != nil {
			return nil, err
		}
		cs := &changeset{}
		cs.ops = append(cs.ops, gitx.Op{Path: cur.Loc.FilePath, Delete: true})
		if cur.Kind.IsFolderKind() {
			att, err := t.f.DB.Attachments(t.ctx, guid)
			if err != nil {
				return nil, err
			}
			for _, a := range att {
				cs.ops = append(cs.ops, gitx.Op{Path: a.Path, Delete: true})
			}
		}
		cascade, err := t.cascade([]string{guid})
		if err != nil {
			return nil, err
		}
		links, comments := 0, 0
		for _, m := range cascade {
			cs.ops = append(cs.ops, gitx.Op{Path: m.Path, Delete: true})
			if m.Kind == model.KindLink {
				links++
			} else {
				comments++
			}
		}
		cs.subject = fmt.Sprintf("%s %s deleted", kindName(cur.Kind), label(cur.Artifact))
		if links+comments > 0 {
			cs.subject += fmt.Sprintf(" (with %d links, %d comments)", links, comments)
		}
		cs.trailer("Corestone-Op", "delete")
		cs.trailer("Corestone-Guid", guid)
		cs.event = Event{Op: "delete", GUID: guid, Kind: string(cur.Kind), Subject: cur.Subject}
		return cs, nil
	})
	return err
}

// cascade collects links/comments attached to the GUIDs, recursively
// (comments on links, replies to comments).
func (t *txn) cascade(guids []string) ([]*model.Summary, error) {
	seen := map[string]bool{}
	for _, g := range guids {
		seen[g] = true
	}
	var out []*model.Summary
	frontier := guids
	for len(frontier) > 0 {
		md, err := t.f.DB.MetadataOf(t.ctx, frontier)
		if err != nil {
			return nil, err
		}
		replies, err := t.f.DB.Replies(t.ctx, frontier)
		if err != nil {
			return nil, err
		}
		frontier = nil
		for _, m := range append(md, replies...) {
			if seen[m.GUID] {
				continue
			}
			seen[m.GUID] = true
			out = append(out, m)
			frontier = append(frontier, m.GUID)
		}
	}
	return out, nil
}

// MoveArtifact relocates an entry or document (with its attachments) to
// another folder and moves its links and comments to the metadata scope
// nearest to the new location (design guide §3.7).
func (f *Foundation) MoveArtifact(ctx context.Context, guid, newPath string) (*View, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if !cur.Kind.IsFolderKind() {
			return nil, model.Invalid("only entries and documents can be moved; metadata follows its subject")
		}
		folder, err := model.CleanFolder(newPath)
		if err != nil {
			return nil, err
		}
		newFile := model.ArtifactDir(folder, guid) + "/" + model.GUIDFile
		view := &View{Meta: summarize(cur.Artifact, folder, newFile, cur.ETag), Data: cur.Doc, ETag: cur.ETag}
		if folder == cur.Loc.Folder {
			return &changeset{result: view}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("%s %s moved from %s to %s", kindName(cur.Kind), label(cur.Artifact), folderName(cur.Loc.Folder), folderName(folder))}
		cs.trailer("Corestone-Op", "move")
		cs.trailer("Corestone-Guid", guid)
		cs.ops = append(cs.ops, gitx.Op{Path: cur.Loc.FilePath, Delete: true}, gitx.Op{Path: newFile, Content: cur.Bytes})
		att, err := t.f.DB.Attachments(t.ctx, guid)
		if err != nil {
			return nil, err
		}
		if len(att) > 0 {
			shas := make([]string, 0, len(att))
			for _, a := range att {
				shas = append(shas, a.ETag)
			}
			blobs, err := t.f.Repo.ReadBlobs(t.ctx, shas)
			if err != nil {
				return nil, err
			}
			for _, a := range att {
				cs.ops = append(cs.ops, gitx.Op{Path: a.Path, Delete: true},
					gitx.Op{Path: model.ArtifactDir(folder, guid) + "/" + a.Name, Content: blobs[a.ETag]})
			}
		}
		// Re-validate workflows/schema at the new location.
		a, _ := model.ArtifactFromDoc(cur.Doc.Clone(), cur.Kind)
		if err := t.validateArtifact(a, folder, cur.Artifact, false); err != nil {
			return nil, fmt.Errorf("at new location: %w", err)
		}
		if content := encode(a.Doc, cur.Style); !bytes.Equal(content, cur.Bytes) {
			cs.ops[1] = gitx.Op{Path: newFile, Content: content}
			view.Data, view.ETag = a.Doc, gitx.BlobSHA(content)
			view.Meta = summarize(a, folder, newFile, view.ETag)
		}
		moved, err := t.relocateMetadata([]string{guid}, map[string]string{guid: folder}, nil)
		if err != nil {
			return nil, err
		}
		cs.ops = append(cs.ops, moved...)
		cs.event = Event{Op: "move", GUID: guid, Kind: string(cur.Kind)}
		cs.result = view
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*View), nil
}

// relocateMetadata computes the file moves that restore metadata locality
// for links (by source) and comments (by subject) of the given artifacts,
// given the folders they will live in. rewrite optionally maps current
// metadata paths that are themselves being moved in the same commit.
func (t *txn) relocateMetadata(guids []string, newFolders map[string]string, rewrite func(string) string) ([]gitx.Op, error) {
	scopes, err := t.f.DB.Scopes(t.ctx)
	if err != nil {
		return nil, err
	}
	scopeSet := map[string]bool{"": true}
	for _, s := range scopes {
		if rewrite != nil {
			s = strings.TrimSuffix(rewrite(s+"/"), "/")
		}
		scopeSet[s] = true
	}
	nearest := func(folder string) string {
		for _, a := range model.Ancestors(folder) {
			if scopeSet[a] {
				return a
			}
		}
		return ""
	}
	md, err := t.f.DB.MetadataOf(t.ctx, guids)
	if err != nil {
		return nil, err
	}
	var ops []gitx.Op
	var shas []string
	type mv struct {
		from, to, sha string
	}
	var moves []mv
	for _, m := range md {
		owner := m.Source
		if m.Kind == model.KindComment {
			owner = m.Subject
		}
		folder, ok := newFolders[owner]
		if !ok {
			continue // attached by target only: stays with its source
		}
		curPath, curScope := m.Path, m.Folder
		if rewrite != nil {
			curPath = rewrite(curPath)
			curScope = strings.TrimSuffix(rewrite(curScope+"/"), "/")
		}
		want := nearest(folder)
		if want == curScope {
			continue
		}
		cat := scanner.ConfigLinks
		if m.Kind == model.KindComment {
			cat = scanner.ConfigComments
		}
		moves = append(moves, mv{from: curPath, to: model.MetadataPath(want, cat, m.GUID), sha: m.ETag})
		shas = append(shas, m.ETag)
	}
	if len(moves) == 0 {
		return nil, nil
	}
	blobs, err := t.f.Repo.ReadBlobs(t.ctx, shas)
	if err != nil {
		return nil, err
	}
	for _, m := range moves {
		ops = append(ops, gitx.Op{Path: m.from, Delete: true}, gitx.Op{Path: m.to, Content: blobs[m.sha]})
	}
	return ops, nil
}

// MoveFolder renames or moves a folder subtree, relocating every artifact,
// attachment, configuration and metadata file below it in one commit
// (design guide §3.7, §10.2). Large operations run in maintenance mode.
func (f *Foundation) MoveFolder(ctx context.Context, from, to string) (int, error) {
	from, err := model.CleanFolder(from)
	if err != nil {
		return 0, err
	}
	to, err = model.CleanFolder(to)
	if err != nil {
		return 0, err
	}
	if from == "" {
		return 0, model.Invalid("the repository root cannot be moved")
	}
	if to == from || model.IsWithin(to, from) {
		return 0, model.Invalid("target folder must not be the source or inside it")
	}
	entered := false
	defer func() {
		if entered {
			f.DB.LeaveMaintenance()
		}
	}()
	res, err := f.write(ctx, true, func(t *txn) (*changeset, error) {
		if !entered && f.DB.Maintenance() {
			return nil, model.ErrMaintenance
		}
		entries, err := t.f.Repo.ListTree(t.ctx, t.head)
		if err != nil {
			return nil, err
		}
		prefix := from + "/"
		rewrite := func(p string) string {
			if strings.HasPrefix(p, prefix) {
				return to + "/" + p[len(prefix):]
			}
			return p
		}
		var moving []gitx.TreeEntry
		existing := map[string]bool{}
		for _, e := range entries {
			existing[e.Path] = true
			if strings.HasPrefix(e.Path, prefix) {
				moving = append(moving, e)
			}
		}
		if len(moving) == 0 {
			return nil, fmt.Errorf("%w: folder %s", model.ErrNotFound, from)
		}
		for _, e := range moving {
			if existing[rewrite(e.Path)] {
				return nil, fmt.Errorf("%w: %s already exists in the target folder", model.ErrConflict, rewrite(e.Path))
			}
		}
		if len(moving) > f.DB.LargeOpThreshold && !entered {
			if !f.DB.EnterMaintenance(fmt.Sprintf("moving folder %s to %s (%d files)", from, to, len(moving))) {
				return nil, model.ErrMaintenance
			}
			entered = true
		}
		var shas []string
		for _, e := range moving {
			shas = append(shas, e.SHA)
		}
		blobs, err := t.f.Repo.ReadBlobs(t.ctx, shas)
		if err != nil {
			return nil, err
		}
		cs := &changeset{subject: fmt.Sprintf("Folder %s moved to %s (%d files)", from, to, len(moving))}
		cs.trailer("Corestone-Op", "move-folder")
		cs.trailer("Corestone-Path", from)
		cs.trailer("Corestone-Path-New", to)
		for _, e := range moving {
			cs.ops = append(cs.ops, gitx.Op{Path: e.Path, Delete: true}, gitx.Op{Path: rewrite(e.Path), Content: blobs[e.SHA]})
		}
		// Metadata of moved artifacts may now belong to a different scope.
		files, err := t.f.DB.FilesUnder(t.ctx, from)
		if err != nil {
			return nil, err
		}
		var guids []string
		newFolders := map[string]string{}
		sc := t.f.DB.Scanner()
		for _, fe := range files {
			if fe.Kind != "artifact" {
				continue
			}
			if m := sc.Classify(fe.Path); m.Category == scanner.Artifact {
				guids = append(guids, fe.GUID)
				newFolders[fe.GUID] = strings.TrimSuffix(rewrite(m.Folder+"/"), "/")
			}
		}
		moved, err := t.relocateMetadata(guids, newFolders, rewrite)
		if err != nil {
			return nil, err
		}
		cs.ops = append(cs.ops, moved...)
		cs.event = Event{Op: "move-folder", Subject: from}
		cs.result = len(moving)
		return cs, nil
	})
	if err != nil {
		return 0, err
	}
	return res.(int), nil
}

// RelocateMetadata is the maintenance operation that restores the
// preferred metadata locality after direct Git operations (§3.4).
func (f *Foundation) RelocateMetadata(ctx context.Context) (int, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		var newFolders = map[string]string{}
		var guids []string
		rows, _, err := t.f.DB.Search(t.ctx, projection.Query{Kinds: []model.Kind{model.KindEntry, model.KindDocument, model.KindLink, model.KindComment}, Subtree: true, Limit: projection.MaxLimit})
		if err != nil {
			return nil, err
		}
		for _, s := range rows {
			guids = append(guids, s.GUID)
			newFolders[s.GUID] = s.Folder
		}
		ops, err := t.relocateMetadata(guids, newFolders, nil)
		if err != nil {
			return nil, err
		}
		if len(ops) == 0 {
			return &changeset{result: 0}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("Metadata locality restored (%d files)", len(ops)/2), ops: ops, result: len(ops) / 2}
		cs.trailer("Corestone-Op", "relocate-metadata")
		cs.event = Event{Op: "relocate-metadata"}
		return cs, nil
	})
	if err != nil {
		return 0, err
	}
	return res.(int), nil
}

var _ = errors.Is
