package foundation

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
)

// Get returns an artifact: projected metadata plus its document from Git.
func (f *Foundation) Get(ctx context.Context, guid string) (*View, error) {
	guid, err := model.NormalizeGUID(guid)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", model.ErrNotFound, err)
	}
	if err := f.catchUp(ctx); err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		meta, err := f.DB.Get(ctx, guid)
		if err != nil {
			return nil, err
		}
		head, err := f.Repo.Head(ctx)
		if err != nil {
			return nil, err
		}
		data, sha, err := f.Repo.ReadPath(ctx, head, meta.Path)
		if errors.Is(err, gitx.ErrNotFound) {
			// The projection may lag behind a direct push: resync once.
			if attempt == 0 {
				if err := f.DB.Sync(ctx); err != nil {
					return nil, err
				}
				continue
			}
			return nil, model.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		doc, err := ojson.ParseObject(data)
		if err != nil {
			doc = ojson.NewObject()
			doc.Set("guid", guid)
			doc.Set("error", "stored file is not a JSON object: "+err.Error())
		}
		meta.ETag = sha
		v := &View{Meta: meta, Data: doc, ETag: sha}
		if meta.Kind.IsFolderKind() {
			if v.Attachments, err = f.DB.Attachments(ctx, guid); err != nil {
				return nil, err
			}
		}
		return v, nil
	}
	return nil, model.ErrNotFound
}

// catchUp resynchronizes the projection when the branch moved behind the
// server's back (a direct push), so reads never miss fresh commits.
func (f *Foundation) catchUp(ctx context.Context) error {
	if f.DB.Maintenance() {
		return nil
	}
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return err
	}
	ph, err := f.DB.ProcessedHash(ctx)
	if err != nil {
		return err
	}
	if ph == head {
		return nil
	}
	return f.DB.Sync(ctx)
}

// Documents reads the documents of many artifacts in one Git batch, keyed
// by GUID (used for comments and relationship endpoints).
func (f *Foundation) Documents(ctx context.Context, metas []*model.Summary) (map[string]*ojson.Object, error) {
	shas := make([]string, 0, len(metas))
	for _, m := range metas {
		shas = append(shas, m.ETag)
	}
	blobs, err := f.Repo.ReadBlobs(ctx, shas)
	if err != nil {
		return nil, err
	}
	out := map[string]*ojson.Object{}
	for _, m := range metas {
		if b, ok := blobs[m.ETag]; ok {
			if doc, err := ojson.ParseObject(b); err == nil {
				out[m.GUID] = doc
			}
		}
	}
	return out, nil
}

// EffectiveSchema resolves the composed schema of a type at a folder.
func (f *Foundation) EffectiveSchema(ctx context.Context, typ, folder string) (*model.Schema, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	schemas, _, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	s := schemas.Effective(typ, folder)
	if s == nil {
		return nil, fmt.Errorf("%w: no schema defines type %q at %s", model.ErrNotFound, typ, folderName(folder))
	}
	return s, nil
}

// Types lists the effective schemas of all types visible from a folder,
// which is what a client offers when creating a new artifact.
func (f *Foundation) Types(ctx context.Context, folder string) ([]*model.Schema, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	schemas, _, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	out := schemas.TypesVisible(folder)
	if out == nil {
		out = []*model.Schema{}
	}
	return out, nil
}

// SchemaOf resolves the effective schema of an existing artifact.
func (f *Foundation) SchemaOf(ctx context.Context, guid string) (*model.Schema, *projection.Located, error) {
	loc, err := f.DB.Locate(ctx, guid)
	if err != nil {
		return nil, nil, err
	}
	schemas, _, err := f.DB.Config(ctx)
	if err != nil {
		return nil, nil, err
	}
	return schemas.Effective(loc.Type, loc.Folder), loc, nil
}

// WorkflowDef resolves a workflow definition visible from a folder.
func (f *Foundation) WorkflowDef(ctx context.Context, id, folder string) (*model.Workflow, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	_, workflows, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	w := workflows.Resolve(id, folder)
	if w == nil {
		return nil, fmt.Errorf("%w: workflow %q at %s", model.ErrNotFound, id, folderName(folder))
	}
	return w, nil
}

// OverlayView is the overlay analysis service result.
type OverlayView struct {
	*model.Overlay
	Overlays []*model.Summary `json:"overlays"` // entries deriving from this one
}

// Overlay analyzes an entry's base chain and lists its own overlays.
func (f *Foundation) Overlay(ctx context.Context, guid string) (*OverlayView, error) {
	v, err := f.Get(ctx, guid)
	if err != nil {
		return nil, err
	}
	a, err := model.ArtifactFromDoc(v.Data, v.Meta.Kind)
	if err != nil {
		return nil, err
	}
	ov, err := model.ResolveOverlay(a, func(g string) (*model.Artifact, error) {
		bv, err := f.Get(ctx, g)
		if err != nil {
			return nil, err
		}
		return model.ArtifactFromDoc(bv.Data, bv.Meta.Kind)
	})
	if err != nil {
		return nil, err
	}
	overlays, err := f.DB.Overlays(ctx, guid)
	if err != nil {
		return nil, err
	}
	if overlays == nil {
		overlays = []*model.Summary{}
	}
	return &OverlayView{Overlay: ov, Overlays: overlays}, nil
}

// WorkflowState is the workflow evaluation of one assigned workflow.
type WorkflowState struct {
	ID         string             `json:"id"`
	Definition *model.Workflow    `json:"definition"`
	State      string             `json:"state"`
	Available  []model.Transition `json:"available"`
}

// Workflows evaluates every workflow assigned to an artifact.
func (f *Foundation) Workflows(ctx context.Context, guid string) ([]WorkflowState, error) {
	v, err := f.Get(ctx, guid)
	if err != nil {
		return nil, err
	}
	schemas, workflows, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	out := []WorkflowState{}
	eff := schemas.Effective(v.Meta.Type, v.Meta.Folder)
	if eff == nil {
		return out, nil
	}
	for _, wid := range eff.AllWorkflows() {
		def := workflows.Resolve(wid, v.Meta.Folder)
		if def == nil {
			continue
		}
		state := v.Meta.Workflows[wid]
		if state == "" {
			state = def.Initial
		}
		av := def.Available(state)
		if av == nil {
			av = []model.Transition{}
		}
		out = append(out, WorkflowState{ID: wid, Definition: def, State: state, Available: av})
	}
	return out, nil
}

// LinkView is a link together with the artifact at its other end.
type LinkView struct {
	Link  *model.Summary `json:"link"`
	Other *model.Summary `json:"other"`
}

// Relationships is the relationship analysis of one artifact.
type Relationships struct {
	Incoming []LinkView      `json:"incoming"`
	Outgoing []LinkView      `json:"outgoing"`
	AsSource []*model.Schema `json:"allowedAsSource"` // link types this artifact may originate
	AsTarget []*model.Schema `json:"allowedAsTarget"`
}

// Relationships lists an artifact's links with their endpoints and the
// link types its schema allows.
func (f *Foundation) Relationships(ctx context.Context, guid string) (*Relationships, error) {
	loc, err := f.DB.Locate(ctx, guid)
	if err != nil {
		return nil, err
	}
	in, out, err := f.DB.LinksOf(ctx, guid)
	if err != nil {
		return nil, err
	}
	r := &Relationships{Incoming: []LinkView{}, Outgoing: []LinkView{}, AsSource: []*model.Schema{}, AsTarget: []*model.Schema{}}
	other := func(l *model.Summary, g string) LinkView {
		o, err := f.DB.Get(ctx, g)
		if err != nil {
			o = &model.Summary{GUID: g, Title: "(missing)"}
		}
		return LinkView{Link: l, Other: o}
	}
	for _, l := range in {
		r.Incoming = append(r.Incoming, other(l, l.Source))
	}
	for _, l := range out {
		r.Outgoing = append(r.Outgoing, other(l, l.Target))
	}
	schemas, _, err := f.DB.Config(ctx)
	if err != nil {
		return nil, err
	}
	src, tgt := schemas.LinkTypesFor(loc.Type, loc.Folder)
	if src != nil {
		r.AsSource = src
	}
	if tgt != nil {
		r.AsTarget = tgt
	}
	return r, nil
}

// CommentView is a comment with its full document.
type CommentView struct {
	Meta *model.Summary `json:"meta"`
	Data *ojson.Object  `json:"data"`
}

// Comments lists the comments on an artifact chronologically, with text.
func (f *Foundation) Comments(ctx context.Context, guid string) ([]CommentView, error) {
	metas, err := f.DB.CommentsOf(ctx, guid)
	if err != nil {
		return nil, err
	}
	docs, err := f.Documents(ctx, metas)
	if err != nil {
		return nil, err
	}
	out := []CommentView{}
	for _, m := range metas {
		out = append(out, CommentView{Meta: m, Data: docs[m.GUID]})
	}
	return out, nil
}

// History lists the commits that touched an artifact, following its GUID
// across moves.
func (f *Foundation) History(ctx context.Context, guid string, limit int) ([]gitx.LogEntry, error) {
	guid, err := model.NormalizeGUID(guid)
	if err != nil {
		return nil, model.ErrNotFound
	}
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, err
	}
	specs := []string{
		":(glob)**/" + guid + "/**",
		":(glob)" + guid + "/**",
		":(glob)**/.corestone/links/" + guid + ".json",
		":(glob)**/.corestone/comments/" + guid + ".json",
		":(glob).corestone/links/" + guid + ".json",
		":(glob).corestone/comments/" + guid + ".json",
	}
	log, err := f.Repo.Log(ctx, head, specs, limit)
	if err != nil {
		return nil, err
	}
	if log == nil {
		log = []gitx.LogEntry{}
	}
	return log, nil
}

// Tree is one level of the repository navigation.
type Tree struct {
	Folder    string                  `json:"folder"`
	Folders   []projection.FolderInfo `json:"folders"`
	Artifacts []*model.Summary        `json:"artifacts"`
	Total     int                     `json:"total"`
}

// Tree lists the child folders of a folder and the entries/documents in
// it (or below it when subtree is set).
func (f *Foundation) Tree(ctx context.Context, folder string, subtree bool, limit, offset int) (*Tree, error) {
	folder, err := model.CleanFolder(folder)
	if err != nil {
		return nil, err
	}
	folders, err := f.DB.Folders(ctx, folder)
	if err != nil {
		return nil, err
	}
	if folders == nil {
		folders = []projection.FolderInfo{}
	}
	arts, total, err := f.DB.Search(ctx, projection.Query{Kinds: []model.Kind{model.KindEntry, model.KindDocument}, Folder: folder, Subtree: subtree, Sort: "path", Limit: limit, Offset: offset})
	if err != nil {
		return nil, err
	}
	if arts == nil {
		arts = []*model.Summary{}
	}
	return &Tree{Folder: folder, Folders: folders, Artifacts: arts, Total: total}, nil
}

// Search is the search service.
func (f *Foundation) Search(ctx context.Context, q projection.Query) ([]*model.Summary, int, error) {
	if q.Folder != "" {
		folder, err := model.CleanFolder(q.Folder)
		if err != nil {
			return nil, 0, err
		}
		q.Folder = folder
	}
	res, total, err := f.DB.Search(ctx, q)
	if res == nil {
		res = []*model.Summary{}
	}
	return res, total, err
}

// Status is the repository status report.
type Status struct {
	Branch     string            `json:"branch"`
	Head       string            `json:"head"`
	Projection projection.Status `json:"projection"`
	InSync     bool              `json:"inSync"`
	Stats      *projection.Stats `json:"stats,omitempty"`
	Scanner    any               `json:"scanner"`
}

// Status reports repository head, projection state and statistics.
func (f *Foundation) Status(ctx context.Context) (*Status, error) {
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, err
	}
	st := f.DB.Status()
	s := &Status{Branch: f.Repo.Branch, Head: head, Projection: st, InSync: st.ProcessedHash == head, Scanner: f.DB.Scanner().Config()}
	if stats, err := f.DB.Stats(ctx); err == nil {
		s.Stats = stats
	}
	return s, nil
}

// Reindex runs a full rebuild in the background and returns immediately.
func (f *Foundation) Reindex() {
	go func() {
		if err := f.DB.Reindex(context.Background()); err != nil {
			log.Printf("foundation: reindex: %v", err)
		}
	}()
}

// SchemaFiles lists schema definition files (all scopes or one scope).
func (f *Foundation) SchemaFiles(ctx context.Context, scope string, all bool) ([]projection.ConfigRecord, error) {
	scope, err := model.CleanFolder(scope)
	if err != nil {
		return nil, err
	}
	return f.DB.ConfigFiles(ctx, "schemas", scope, all)
}

// WorkflowFiles lists workflow definition files.
func (f *Foundation) WorkflowFiles(ctx context.Context, scope string, all bool) ([]projection.ConfigRecord, error) {
	scope, err := model.CleanFolder(scope)
	if err != nil {
		return nil, err
	}
	return f.DB.ConfigFiles(ctx, "workflows", scope, all)
}

// HIDLookup resolves a HID to its current and historical owners.
func (f *Foundation) HIDLookup(ctx context.Context, hid string) ([]projection.HIDRecord, error) {
	recs, err := f.DB.HIDHistory(ctx, hid, "")
	if err != nil {
		return nil, err
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].Current && !recs[j].Current })
	return recs, nil
}
