package foundation

import (
	"context"
	"fmt"
	"strings"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// CreateLink creates a directed typed relationship. Request properties:
// type, source, target, fields. When a link schema for the type is visible
// from the source artifact its endpoint types and cardinality are enforced.
func (f *Foundation) CreateLink(ctx context.Context, req *ojson.Object) (*View, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		typ := strings.TrimSpace(req.String("type"))
		src, err := model.NormalizeGUID(req.String("source"))
		if err != nil {
			return nil, fmt.Errorf("source: %w", err)
		}
		tgt, err := model.NormalizeGUID(req.String("target"))
		if err != nil {
			return nil, fmt.Errorf("target: %w", err)
		}
		if src == tgt {
			return nil, model.Invalid("a link cannot connect an artifact to itself")
		}
		srcLoc, err := t.exists(src)
		if err != nil {
			return nil, err
		}
		tgtLoc, err := t.exists(tgt)
		if err != nil {
			return nil, err
		}
		guid := model.NewGUID()
		doc := model.NewDoc(model.KindLink, guid, typ)
		doc.Set("source", src)
		doc.Set("target", tgt)
		fields := req.Object("fields")
		if fields == nil {
			fields = ojson.NewObject()
		}
		doc.Set("fields", fields.Clone())
		a, err := model.ArtifactFromDoc(doc, model.KindLink)
		if err != nil {
			return nil, err
		}
		if err := a.Validate(); err != nil {
			return nil, err
		}
		if dup, err := t.f.DB.FindLink(t.ctx, typ, src, tgt); err != nil {
			return nil, err
		} else if dup != "" {
			return nil, fmt.Errorf("%w: link %s already exists (%s)", model.ErrConflict, typ, dup)
		}
		eff := t.schemas.Effective(typ, srcLoc.Folder)
		if eff != nil {
			if eff.Kind != model.KindLink {
				return nil, model.Invalid("type %q is not a link type", typ)
			}
			if !model.AllowsEndpoint(eff.SourceTypes, srcLoc.Type) {
				return nil, model.Invalid("link type %q does not allow %q as source", typ, srcLoc.Type)
			}
			if !model.AllowsEndpoint(eff.TargetTypes, tgtLoc.Type) {
				return nil, model.Invalid("link type %q does not allow %q as target", typ, tgtLoc.Type)
			}
			if err := t.checkCardinality(eff, typ, src, tgt); err != nil {
				return nil, err
			}
		}
		if err := t.validateLinkFields(a, srcLoc.Folder); err != nil {
			return nil, err
		}
		scope, err := t.f.DB.NearestScope(t.ctx, srcLoc.Folder)
		if err != nil {
			return nil, err
		}
		path := model.MetadataPath(scope, scanner.ConfigLinks, guid)
		content := encode(doc, ojson.DefaultStyle)
		srcL, tgtL := src, tgt
		if s, err := t.load(src); err == nil {
			srcL = label(s.Artifact)
		}
		if s, err := t.load(tgt); err == nil {
			tgtL = label(s.Artifact)
		}
		cs := &changeset{subject: fmt.Sprintf("Link %s from %s to %s created", typ, srcL, tgtL)}
		cs.trailer("Corestone-Op", "create")
		cs.trailer("Corestone-Guid", guid)
		cs.trailer("Corestone-Kind", "link")
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "create", GUID: guid, Kind: "link", Subject: src}
		cs.result = &View{Meta: summarize(a, scope, path, gitx.BlobSHA(content)), Data: doc, ETag: gitx.BlobSHA(content)}
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*View), nil
}

func (t *txn) checkCardinality(eff *model.Schema, typ, src, tgt string) error {
	fromSrc, err := t.f.DB.CountLinks(t.ctx, typ, src, "")
	if err != nil {
		return err
	}
	toTgt, err := t.f.DB.CountLinks(t.ctx, typ, "", tgt)
	if err != nil {
		return err
	}
	switch eff.Cardinality {
	case model.OneToOne:
		if fromSrc > 0 || toTgt > 0 {
			return fmt.Errorf("%w: link type %s is one-to-one and an endpoint is already linked", model.ErrConflict, typ)
		}
	case model.OneToMany:
		if toTgt > 0 {
			return fmt.Errorf("%w: link type %s is one-to-many and the target already has a source", model.ErrConflict, typ)
		}
	case model.ManyToOne:
		if fromSrc > 0 {
			return fmt.Errorf("%w: link type %s is many-to-one and the source already has a target", model.ErrConflict, typ)
		}
	}
	return nil
}

// validateLinkFields validates a link's fields and workflow states against
// the link schema visible from its storage scope.
func (t *txn) validateLinkFields(a *model.Artifact, folder string) error {
	return t.validateTyped(a, folder)
}

// validateTyped validates fields and initializes workflows for links and
// comments (whose schemas are optional).
func (t *txn) validateTyped(a *model.Artifact, folder string) error {
	eff := t.schemas.Effective(a.Type, folder)
	if eff == nil {
		return nil
	}
	if eff.Kind != a.Kind {
		return model.Invalid("type %q describes %ss, not %ss", a.Type, eff.Kind, a.Kind)
	}
	if err := t.validateFields(eff, a.Fields, a.Fields); err != nil {
		return err
	}
	for _, wid := range eff.AllWorkflows() {
		if _, has := a.Workflows[wid]; has {
			continue
		}
		def := t.workflows.Resolve(wid, folder)
		if def == nil {
			return model.Invalid("schema %q assigns workflow %q which is not defined", a.Type, wid)
		}
		a.SetWorkflowState(wid, def.Initial)
	}
	return nil
}

// CreateComment attaches a comment to any artifact. Request properties:
// subject, parent, text, author, type (default "comment"), anchor, fields.
func (f *Foundation) CreateComment(ctx context.Context, req *ojson.Object) (*View, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		subject, err := model.NormalizeGUID(req.String("subject"))
		if err != nil {
			return nil, fmt.Errorf("subject: %w", err)
		}
		subjLoc, err := t.exists(subject)
		if err != nil {
			return nil, err
		}
		typ := strings.TrimSpace(req.String("type"))
		if typ == "" {
			typ = "comment"
		}
		guid := model.NewGUID()
		doc := model.NewDoc(model.KindComment, guid, typ)
		doc.Set("subject", subject)
		if p := req.String("parent"); p != "" {
			parent, err := model.NormalizeGUID(p)
			if err != nil {
				return nil, fmt.Errorf("parent: %w", err)
			}
			pl, err := t.load(parent)
			if err != nil {
				return nil, err
			}
			if pl.Kind != model.KindComment || pl.Subject != subject {
				return nil, model.Invalid("parent must be a comment on the same subject")
			}
			doc.Set("parent", parent)
		}
		author := strings.TrimSpace(req.String("author"))
		if author == "" {
			author = "anonymous"
		}
		doc.Set("author", author)
		doc.Set("created", model.Now())
		doc.Set("text", strings.TrimSpace(req.String("text")))
		if anchor := req.Object("anchor"); anchor != nil {
			doc.Set("anchor", anchor.Clone())
		}
		if fields := req.Object("fields"); fields != nil && fields.Len() > 0 {
			doc.Set("fields", fields.Clone())
		}
		a, err := model.ArtifactFromDoc(doc, model.KindComment)
		if err != nil {
			return nil, err
		}
		if err := a.Validate(); err != nil {
			return nil, err
		}
		if err := t.validateTyped(a, subjLoc.Folder); err != nil {
			return nil, err
		}
		scope, err := t.f.DB.NearestScope(t.ctx, subjLoc.Folder)
		if err != nil {
			return nil, err
		}
		path := model.MetadataPath(scope, scanner.ConfigComments, guid)
		content := encode(doc, ojson.DefaultStyle)
		subjL := subject
		if s, err := t.load(subject); err == nil {
			subjL = label(s.Artifact)
		}
		cs := &changeset{subject: fmt.Sprintf("Comment added to %s", subjL)}
		cs.trailer("Corestone-Op", "create")
		cs.trailer("Corestone-Guid", guid)
		cs.trailer("Corestone-Kind", "comment")
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "create", GUID: guid, Kind: "comment", Subject: subject}
		cs.result = &View{Meta: summarize(a, scope, path, gitx.BlobSHA(content)), Data: doc, ETag: gitx.BlobSHA(content)}
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*View), nil
}

// Transition moves one of an artifact's workflows to a new state (by
// target state id or by transition id).
func (f *Foundation) Transition(ctx context.Context, guid, workflow, to, ifMatch string) (*View, error) {
	res, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if err := checkETag(ifMatch, cur.ETag); err != nil {
			return nil, err
		}
		eff := t.schemas.Effective(cur.Type, cur.Loc.Folder)
		if eff == nil {
			return nil, model.Invalid("no schema defines type %q here, so it has no workflows", cur.Type)
		}
		assigned := false
		for _, w := range eff.AllWorkflows() {
			if w == workflow {
				assigned = true
			}
		}
		if !assigned {
			return nil, model.Invalid("workflow %q is not assigned to type %q", workflow, cur.Type)
		}
		def := t.workflows.Resolve(workflow, cur.Loc.Folder)
		if def == nil {
			return nil, model.Invalid("workflow %q is not defined at %s", workflow, folderName(cur.Loc.Folder))
		}
		from, ok := cur.Workflows[workflow]
		if !ok || from == "" {
			from = def.Initial
		}
		tr, ok := def.Find(from, to)
		if !ok {
			return nil, model.Invalid("no transition from %q to %q in workflow %q", from, to, workflow)
		}
		doc := cur.Doc.Clone()
		a, _ := model.ArtifactFromDoc(doc, cur.Kind)
		a.SetWorkflowState(workflow, tr.To)
		content := encode(doc, cur.Style)
		view := &View{Meta: summarize(a, cur.Loc.Folder, cur.Loc.FilePath, gitx.BlobSHA(content)), Data: doc, ETag: gitx.BlobSHA(content)}
		if from == tr.To {
			return &changeset{result: view}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("Workflow %s: %s transitioned from %s to %s", workflow, label(cur.Artifact), from, tr.To)}
		cs.trailer("Corestone-Op", "transition")
		cs.trailer("Corestone-Guid", guid)
		cs.trailer("Corestone-Workflow", workflow)
		cs.ops = []gitx.Op{{Path: cur.Loc.FilePath, Content: content}}
		cs.event = Event{Op: "transition", GUID: guid, Kind: string(cur.Kind)}
		cs.result = view
		return cs, nil
	})
	if err != nil {
		return nil, err
	}
	return res.(*View), nil
}
