// Package foundation is the Corestone Foundation service: it turns logical
// repository operations into single Git commits, keeps the PostgreSQL
// projection synchronized with the §10.1 transaction, and exposes the
// service APIs (effective schemas, overlays, workflow evaluation,
// relationship analysis, validation, history).
package foundation

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
)

// Foundation owns one repository and its projection.
type Foundation struct {
	Repo *gitx.Repo
	DB   *projection.DB

	MaxAttempts int

	// writeMu serializes writers within one process: Git commits are serial
	// anyway, and queueing beats a thundering herd of CAS retries. Writers in
	// other processes are still coordinated by the two compare-and-swaps.
	writeMu sync.Mutex

	subMu sync.RWMutex
	subs  []func(Event)
}

// Event describes a published repository change.
type Event struct {
	Type    string `json:"type"` // "commit", "status"
	Op      string `json:"op,omitempty"`
	GUID    string `json:"guid,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Subject string `json:"subject,omitempty"`
	Commit  string `json:"commit,omitempty"`
	Message string `json:"message,omitempty"`
	Status  any    `json:"status,omitempty"`
	At      string `json:"at"`
}

// Open opens (or creates) the bare repository and the projection, then
// synchronizes the projection with the repository head.
func Open(ctx context.Context, repoDir, branch, dsn string) (*Foundation, error) {
	repo, err := gitx.Open(repoDir, branch)
	if err != nil {
		return nil, err
	}
	db, err := projection.Open(ctx, dsn, repo)
	if err != nil {
		return nil, err
	}
	f := &Foundation{Repo: repo, DB: db, MaxAttempts: 25}
	db.OnStatus = func(s projection.Status) {
		f.emit(Event{Type: "status", Status: s, At: model.Now()})
	}
	if err := db.Sync(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return f, nil
}

// Close releases the projection database.
func (f *Foundation) Close() error { return f.DB.Close() }

// Subscribe registers an event listener (used by the WebSocket service).
func (f *Foundation) Subscribe(fn func(Event)) {
	f.subMu.Lock()
	f.subs = append(f.subs, fn)
	f.subMu.Unlock()
}

func (f *Foundation) emit(e Event) {
	f.subMu.RLock()
	subs := make([]func(Event), len(f.subs))
	copy(subs, f.subs)
	f.subMu.RUnlock()
	for _, s := range subs {
		s(e)
	}
}

// Watch re-synchronizes the projection whenever the branch moves behind
// the server's back (direct pushes), until ctx is cancelled.
func (f *Foundation) Watch(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if f.DB.Maintenance() {
				continue
			}
			head, err := f.Repo.Head(ctx)
			if err != nil {
				continue
			}
			if ph, err := f.DB.ProcessedHash(ctx); err == nil && ph != head {
				if err := f.DB.Sync(ctx); err != nil {
					log.Printf("foundation: background sync: %v", err)
				} else {
					f.emit(Event{Type: "commit", Op: "external", Commit: head, Message: "repository updated externally", At: model.Now()})
				}
			}
		}
	}
}

// ---- the repository update transaction (design guide §10.1) -------------

// changeset is everything one logical operation wants to publish.
type changeset struct {
	subject  string
	trailers [][2]string
	ops      []gitx.Op
	event    Event
	result   any
}

func (c *changeset) trailer(k, v string) { c.trailers = append(c.trailers, [2]string{k, v}) }

func (c *changeset) message() string {
	var b strings.Builder
	b.WriteString(c.subject)
	b.WriteString("\n\n")
	for _, t := range c.trailers {
		b.WriteString(t[0])
		b.WriteString(": ")
		b.WriteString(t[1])
		b.WriteString("\n")
	}
	return b.String()
}

// txn is the state one attempt of the transaction validates against.
type txn struct {
	f         *Foundation
	ctx       context.Context
	head      string
	schemas   *model.SchemaIndex
	workflows *model.WorkflowIndex
	ops       map[string]gitx.Op // staged ops by path (last wins)
}

// prepare builds the changeset for one attempt. It is re-run from scratch
// whenever the branch moved, so every validation always sees the head it
// is published on top of.
type prepare func(t *txn) (*changeset, error)

// write runs the §10.1 sequence:
//
//	sync projection → build changeset & commit object → begin DB tx →
//	project commit → [mutex] publish (CAS) → advance processed_hash →
//	[release] → commit DB tx; on a stale CAS: rollback, rebuild, retry.
func (f *Foundation) write(ctx context.Context, allowMaintenance bool, build prepare) (any, error) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	var lastErr error
	for attempt := 0; attempt < f.MaxAttempts; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(5+rand.Intn(20*attempt)) * time.Millisecond
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if !allowMaintenance {
			if f.DB.Maintenance() {
				return nil, model.ErrMaintenance
			}
			if reason, err := f.DB.RemoteMaintenance(ctx); err != nil {
				return nil, err
			} else if reason != "" {
				return nil, fmt.Errorf("%w: %s", model.ErrMaintenance, reason)
			}
		}
		if err := f.DB.Sync(ctx); err != nil {
			if errors.Is(err, model.ErrConflict) {
				lastErr = err
				continue
			}
			return nil, err
		}
		head, err := f.Repo.Head(ctx)
		if err != nil {
			return nil, err
		}
		if ph, err := f.DB.ProcessedHash(ctx); err != nil {
			return nil, err
		} else if ph != head {
			lastErr = fmt.Errorf("%w: projection behind repository", model.ErrConflict)
			continue
		}
		schemas, workflows, err := f.DB.Config(ctx)
		if err != nil {
			return nil, err
		}
		t := &txn{f: f, ctx: ctx, head: head, schemas: schemas, workflows: workflows, ops: map[string]gitx.Op{}}
		cs, err := build(t)
		if err != nil {
			// A conflict raised while validating may be transient: another
			// writer published meanwhile. Retry on a fresh head in that case.
			if errors.Is(err, model.ErrConflict) {
				if h, herr := f.Repo.Head(ctx); herr == nil && h != head {
					lastErr = err
					continue
				}
			}
			return nil, err
		}
		if cs == nil || len(cs.ops) == 0 {
			if cs != nil {
				return cs.result, nil
			}
			return nil, nil
		}
		commit, err := f.Repo.BuildCommit(ctx, head, cs.message(), cs.ops)
		if err != nil {
			return nil, err
		}
		changes, err := f.Repo.DiffTree(ctx, head, commit)
		if err != nil {
			return nil, err
		}
		now := time.Now().UTC()
		tx, err := f.DB.Begin(ctx)
		if err != nil {
			return nil, err
		}
		if err := f.DB.ProjectCommit(ctx, tx, commit, changes, now); err != nil {
			tx.Rollback()
			if errors.Is(err, model.ErrUnavailable) {
				lastErr = err
				continue
			}
			return nil, err
		}
		mu := f.DB.PublishMutex()
		mu.Lock()
		err = f.Repo.Publish(ctx, head, commit)
		if err != nil {
			mu.Unlock()
			tx.Rollback()
			if errors.Is(err, gitx.ErrStale) {
				lastErr = fmt.Errorf("%w: repository changed concurrently", model.ErrConflict)
				continue
			}
			return nil, err
		}
		ok, err := f.DB.AdvanceProcessed(ctx, tx, head, commit)
		mu.Unlock()
		if err != nil || !ok {
			// Git holds the commit; the projection will catch up by replay.
			tx.Rollback()
			if err != nil {
				log.Printf("foundation: processed_hash update failed after publishing %s: %v", commit, err)
			}
		} else if err := tx.Commit(); err != nil {
			log.Printf("foundation: projection commit failed after publishing %s: %v (will replay)", commit, err)
		}
		cs.event.Type, cs.event.Commit, cs.event.At = "commit", commit, model.Now()
		cs.event.Message = cs.subject
		f.emit(cs.event)
		return cs.result, nil
	}
	if lastErr == nil {
		lastErr = model.ErrConflict
	}
	return nil, fmt.Errorf("%w: giving up after %d attempts (%v)", model.ErrConflict, f.MaxAttempts, lastErr)
}

// ---- txn helpers ----------------------------------------------------------

// loaded is an artifact read from the head this transaction builds on.
type loaded struct {
	*model.Artifact
	Loc   *projection.Located
	Bytes []byte
	Style ojson.Style
	ETag  string
}

func (t *txn) load(guid string) (*loaded, error) {
	loc, err := t.f.DB.Locate(t.ctx, guid)
	if err != nil {
		return nil, err
	}
	data, sha, err := t.f.Repo.ReadPath(t.ctx, t.head, loc.FilePath)
	if errors.Is(err, gitx.ErrNotFound) {
		return nil, fmt.Errorf("%w: projection and repository disagree about %s", model.ErrConflict, guid)
	}
	if err != nil {
		return nil, err
	}
	a, err := model.ParseArtifact(data, loc.Kind)
	if err != nil {
		return nil, fmt.Errorf("%w: stored artifact %s is malformed: %v", model.ErrValidation, guid, err)
	}
	return &loaded{Artifact: a, Loc: loc, Bytes: data, Style: ojson.DetectStyle(data), ETag: sha}, nil
}

// exists checks that a referenced artifact exists (and optionally has a kind).
func (t *txn) exists(guid string, kinds ...model.Kind) (*projection.Located, error) {
	loc, err := t.f.DB.Locate(t.ctx, guid)
	if errors.Is(err, model.ErrNotFound) {
		return nil, model.Invalid("referenced artifact %s does not exist", guid)
	}
	if err != nil {
		return nil, err
	}
	if len(kinds) > 0 {
		ok := false
		for _, k := range kinds {
			if loc.Kind == k {
				ok = true
			}
		}
		if !ok {
			return nil, model.Invalid("artifact %s is a %s", guid, loc.Kind)
		}
	}
	return loc, nil
}

func checkETag(ifMatch, current string) error {
	if ifMatch == "" || ifMatch == "*" {
		return nil
	}
	if ifMatch != current {
		return fmt.Errorf("%w: artifact was modified (current ETag %s)", model.ErrPrecondition, current)
	}
	return nil
}

// encode serializes an artifact document in its existing style (or the
// default style for new files), so unchanged files stay byte-identical.
func encode(doc *ojson.Object, style ojson.Style) []byte {
	if style.Indent == "" && style.Newline == "" {
		style = ojson.DefaultStyle
	}
	if style.Newline == "" {
		style.Newline = "\n"
	}
	return ojson.MustEncode(doc, style)
}

func label(a *model.Artifact) string {
	if a.HID != "" {
		return a.HID
	}
	return a.GUID
}

func kindName(k model.Kind) string {
	switch k {
	case model.KindEntry:
		return "Entry"
	case model.KindDocument:
		return "Document"
	case model.KindLink:
		return "Link"
	case model.KindComment:
		return "Comment"
	}
	return string(k)
}

func folderName(folder string) string {
	if folder == "" {
		return "/"
	}
	return folder
}
