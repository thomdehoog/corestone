package foundation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// PutSchema stores a schema definition for a type in a scope.
func (f *Foundation) PutSchema(ctx context.Context, scope, typ string, body []byte) (*model.Schema, error) {
	s, err := model.ParseSchema(body)
	if err != nil {
		return nil, err
	}
	if s.Type != typ {
		return nil, model.Invalid("schema type %q must match the name %q", s.Type, typ)
	}
	if err := f.putConfig(ctx, scope, scanner.ConfigSchemas, typ, body, "Schema"); err != nil {
		return nil, err
	}
	return s, nil
}

// PutWorkflow stores a workflow definition in a scope.
func (f *Foundation) PutWorkflow(ctx context.Context, scope, id string, body []byte) (*model.Workflow, error) {
	w, err := model.ParseWorkflow(body)
	if err != nil {
		return nil, err
	}
	if w.ID != id {
		return nil, model.Invalid("workflow id %q must match the name %q", w.ID, id)
	}
	if err := f.putConfig(ctx, scope, scanner.ConfigWorkflows, id, body, "Workflow"); err != nil {
		return nil, err
	}
	return w, nil
}

func (f *Foundation) putConfig(ctx context.Context, scope, category, name string, body []byte, what string) error {
	scope, err := model.CleanFolder(scope)
	if err != nil {
		return err
	}
	if err := model.ValidateTypeID(name); err != nil {
		return err
	}
	obj, err := ojson.ParseObject(body)
	if err != nil {
		return model.Invalid("%v", err)
	}
	_, err = f.write(ctx, false, func(t *txn) (*changeset, error) {
		path := model.MetadataPath(scope, category, name)
		style := ojson.DefaultStyle
		verb := "created"
		old, _, err := t.f.Repo.ReadPath(t.ctx, t.head, path)
		if err == nil {
			style = ojson.DetectStyle(old)
			verb = "updated"
		} else if !errors.Is(err, gitx.ErrNotFound) {
			return nil, err
		}
		content := encode(obj, style)
		if bytes.Equal(content, old) {
			return &changeset{}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("%s %s in %s %s", what, name, folderName(scope), verb)}
		cs.trailer("Corestone-Op", "config")
		cs.trailer("Corestone-Path", path)
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "config", Subject: path}
		return cs, nil
	})
	return err
}

// DeleteSchema removes a schema definition file.
func (f *Foundation) DeleteSchema(ctx context.Context, scope, typ string) error {
	return f.deleteConfig(ctx, scope, scanner.ConfigSchemas, typ, "Schema")
}

// DeleteWorkflow removes a workflow definition file.
func (f *Foundation) DeleteWorkflow(ctx context.Context, scope, id string) error {
	return f.deleteConfig(ctx, scope, scanner.ConfigWorkflows, id, "Workflow")
}

func (f *Foundation) deleteConfig(ctx context.Context, scope, category, name, what string) error {
	scope, err := model.CleanFolder(scope)
	if err != nil {
		return err
	}
	if err := model.ValidateTypeID(name); err != nil {
		return err
	}
	_, err = f.write(ctx, false, func(t *txn) (*changeset, error) {
		path := model.MetadataPath(scope, category, name)
		if _, _, err := t.f.Repo.ReadPath(t.ctx, t.head, path); err != nil {
			if errors.Is(err, gitx.ErrNotFound) {
				return nil, fmt.Errorf("%w: %s", model.ErrNotFound, path)
			}
			return nil, err
		}
		cs := &changeset{subject: fmt.Sprintf("%s %s in %s deleted", what, name, folderName(scope))}
		cs.trailer("Corestone-Op", "config")
		cs.trailer("Corestone-Path", path)
		cs.ops = []gitx.Op{{Path: path, Delete: true}}
		cs.event = Event{Op: "config", Subject: path}
		return cs, nil
	})
	return err
}

// ValidateAttachmentName checks a file name inside a GUID directory.
func ValidateAttachmentName(name string) error {
	if err := model.ValidateSegment(name); err != nil {
		return err
	}
	if name == model.GUIDFile || strings.HasPrefix(name, ".corestone") {
		return model.Invalid("%q is reserved", name)
	}
	return nil
}

// PutAttachment stores a file inside an artifact's GUID directory.
func (f *Foundation) PutAttachment(ctx context.Context, guid, name string, content []byte) error {
	if err := ValidateAttachmentName(name); err != nil {
		return err
	}
	_, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		if !cur.Kind.IsFolderKind() {
			return nil, model.Invalid("only entries and documents can hold attachments")
		}
		path := model.ArtifactDir(cur.Loc.Folder, guid) + "/" + name
		if old, _, err := t.f.Repo.ReadPath(t.ctx, t.head, path); err == nil && bytes.Equal(old, content) {
			return &changeset{}, nil
		}
		cs := &changeset{subject: fmt.Sprintf("Attachment %s of %s stored", name, label(cur.Artifact))}
		cs.trailer("Corestone-Op", "attachment")
		cs.trailer("Corestone-Guid", guid)
		cs.ops = []gitx.Op{{Path: path, Content: content}}
		cs.event = Event{Op: "attachment", GUID: guid, Kind: string(cur.Kind)}
		return cs, nil
	})
	return err
}

// DeleteAttachment removes a file from an artifact's GUID directory.
func (f *Foundation) DeleteAttachment(ctx context.Context, guid, name string) error {
	if err := ValidateAttachmentName(name); err != nil {
		return err
	}
	_, err := f.write(ctx, false, func(t *txn) (*changeset, error) {
		cur, err := t.load(guid)
		if err != nil {
			return nil, err
		}
		path := model.ArtifactDir(cur.Loc.Folder, guid) + "/" + name
		if _, _, err := t.f.Repo.ReadPath(t.ctx, t.head, path); err != nil {
			if errors.Is(err, gitx.ErrNotFound) {
				return nil, fmt.Errorf("%w: attachment %s", model.ErrNotFound, name)
			}
			return nil, err
		}
		cs := &changeset{subject: fmt.Sprintf("Attachment %s of %s removed", name, label(cur.Artifact))}
		cs.trailer("Corestone-Op", "attachment")
		cs.trailer("Corestone-Guid", guid)
		cs.ops = []gitx.Op{{Path: path, Delete: true}}
		cs.event = Event{Op: "attachment", GUID: guid, Kind: string(cur.Kind)}
		return cs, nil
	})
	return err
}

// Attachment reads a file from an artifact's GUID directory.
func (f *Foundation) Attachment(ctx context.Context, guid, name string) ([]byte, string, error) {
	if err := ValidateAttachmentName(name); err != nil {
		return nil, "", err
	}
	loc, err := f.DB.Locate(ctx, guid)
	if err != nil {
		return nil, "", err
	}
	head, err := f.Repo.Head(ctx)
	if err != nil {
		return nil, "", err
	}
	data, sha, err := f.Repo.ReadPath(ctx, head, model.ArtifactDir(loc.Folder, guid)+"/"+name)
	if errors.Is(err, gitx.ErrNotFound) {
		return nil, "", model.ErrNotFound
	}
	return data, sha, err
}
