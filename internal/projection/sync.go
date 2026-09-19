package projection

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// Sync brings the projection to the repository head (design guide §5.13):
// if processed_hash equals HEAD nothing happens; if HEAD descends from it on
// the first-parent chain the missing commits are replayed sequentially,
// each in its own transaction; otherwise a full rebuild runs.
func (p *DB) Sync(ctx context.Context) error {
	// A rebuild holds syncMu for its whole duration. Callers must not queue
	// behind it (a request would hang for minutes on a large repository):
	// maintenance mode is reported instead, and clients retry.
	if !p.syncMu.TryLock() {
		if p.Maintenance() {
			return fmt.Errorf("%w: %s", model.ErrMaintenance, p.Status().Reason)
		}
		p.syncMu.Lock()
	}
	defer p.syncMu.Unlock()
	// processed_hash is read before HEAD: another process may publish and
	// advance the projection between the two reads, and then the projection
	// is simply ahead of the head we saw, which is not a divergence.
	processed, err := p.ProcessedHash(ctx)
	if err != nil {
		return err
	}
	head, err := p.repo.Head(ctx)
	if err != nil {
		return err
	}
	if processed == head {
		return nil
	}
	if head == "" {
		return p.rebuildLocked(ctx, "repository is empty")
	}
	if processed == "" || !p.repo.Exists(ctx, processed) {
		return p.rebuildLocked(ctx, "no usable processed revision")
	}
	if ahead, _ := p.repo.IsAncestor(ctx, head, processed); ahead {
		// Projection ahead of HEAD: either a stale head read (fine) or the
		// branch was rewound by a force push (rebuild).
		if again, err := p.repo.Head(ctx); err != nil || again != head {
			return err
		}
		if cur, _ := p.ProcessedHash(ctx); cur != processed {
			return nil
		}
		return p.rebuildLocked(ctx, "branch was rewound")
	}
	chain, err := p.repo.FirstParentChain(ctx, processed, head)
	if err != nil || len(chain) == 0 || len(chain[0].Parents) == 0 || chain[0].Parents[0] != processed {
		return p.rebuildLocked(ctx, "processed revision is not on the first-parent chain of HEAD")
	}
	if err := p.loadScanner(ctx, head); err != nil {
		return err
	}
	for _, c := range chain {
		if err := p.replayOne(ctx, c.Parents[0], c.SHA); err != nil {
			return err
		}
	}
	return nil
}

func (p *DB) replayOne(ctx context.Context, parent, commit string) error {
	cur, err := p.ProcessedHash(ctx)
	if err != nil {
		return err
	}
	if cur != parent {
		// Someone else (another server process) already moved past this
		// commit, or the projection diverged; Sync's caller will re-check.
		if cur == commit {
			return nil
		}
		if ok, _ := p.repo.IsAncestor(ctx, commit, cur); ok {
			return nil
		}
		return fmt.Errorf("%w: projection moved to %s while replaying %s", model.ErrConflict, cur, commit)
	}
	changes, err := p.repo.DiffTree(ctx, parent, commit)
	if err != nil {
		return err
	}
	info, err := p.repo.Log(ctx, commit, nil, 1)
	if err != nil {
		return err
	}
	when := time.Now()
	if len(info) > 0 {
		when = info[0].Time
	}
	tx, err := p.Begin(ctx)
	if err != nil {
		return unavailable(err)
	}
	defer tx.Rollback()
	if err := p.ProjectCommit(ctx, tx, commit, changes, when); err != nil {
		return err
	}
	ok, err := p.AdvanceProcessed(ctx, tx, parent, commit)
	if err != nil {
		return err
	}
	if !ok {
		return nil // lost the race; whoever won projected the same commit
	}
	return unavailable(tx.Commit())
}

// ProjectCommit applies one commit's changes to the projection inside tx.
// It never touches processed_hash (§10.1 step "update database projection
// excluding processed_hash").
func (p *DB) ProjectCommit(ctx context.Context, tx *sql.Tx, commit string, changes []gitx.Change, when time.Time) error {
	sc := p.Scanner()
	type upd struct {
		m  scanner.Match
		ch gitx.Change
	}
	var (
		adds     []upd
		dels     []upd
		attaches []upd
		configs  []upd
	)
	for _, ch := range changes {
		m, ok := sc.Match(ch.Path)
		if !ok {
			continue
		}
		u := upd{m, ch}
		switch m.Category {
		case scanner.Attachment:
			attaches = append(attaches, u)
		case scanner.ConfigFile:
			if m.ConfigKind == scanner.ConfigLinks || m.ConfigKind == scanner.ConfigComments {
				if ch.Status == 'D' {
					dels = append(dels, u)
				} else {
					adds = append(adds, u)
				}
			} else {
				configs = append(configs, u)
			}
		case scanner.Artifact:
			if ch.Status == 'D' {
				dels = append(dels, u)
			} else {
				adds = append(adds, u)
			}
		}
	}

	// Fetch all needed blobs in one batch.
	var shas []string
	for _, u := range adds {
		shas = append(shas, u.ch.SHA)
	}
	for _, u := range configs {
		if u.ch.Status != 'D' {
			shas = append(shas, u.ch.SHA)
		}
	}
	blobs, err := p.repo.ReadBlobs(ctx, shas)
	if err != nil {
		return err
	}

	// Additions / modifications first so that a move (D+A of the same GUID
	// in one commit) is seen as a relocation, not a deletion.
	removed := map[string]bool{}
	for _, u := range dels {
		removed[u.ch.Path] = true
	}
	touched := map[string]bool{}
	for _, u := range adds {
		content, ok := blobs[u.ch.SHA]
		if !ok {
			return fmt.Errorf("%w: blob %s missing", gitx.ErrNotFound, u.ch.SHA)
		}
		rec := extract(u.m, u.ch.SHA, content)
		if rec.GUID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM file_issues WHERE path = $1`, rec.Path); err != nil {
			return unavailable(err)
		}
		touched[rec.GUID] = true
		if err := p.upsertRecord(ctx, tx, rec, commit, when, removed); err != nil {
			return err
		}
	}
	for _, u := range dels {
		guid := u.m.GUID
		if u.m.Category == scanner.ConfigFile {
			guid = u.m.Name
		}
		if guid == "" || touched[guid] {
			continue
		}
		// The file may belong to a GUID whose row is keyed by the guid in the
		// file; look the row up by path as well.
		if err := p.deleteByPath(ctx, tx, u.ch.Path, guid, commit, when); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM file_issues WHERE path = $1`, u.ch.Path); err != nil {
			return unavailable(err)
		}
		// A file that previously lost a GUID conflict may now be its rightful owner.
		if err := p.promoteClaimants(ctx, tx, guid, commit, when, removed); err != nil {
			return err
		}
	}
	for _, u := range attaches {
		if u.ch.Status == 'D' {
			if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_files WHERE path = $1`, u.ch.Path); err != nil {
				return unavailable(err)
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_files (guid, name, path, blob_sha, size) VALUES ($1,$2,$3,$4,0)
			ON CONFLICT (guid, name) DO UPDATE SET path = EXCLUDED.path, blob_sha = EXCLUDED.blob_sha`,
			u.m.GUID, u.m.Name, u.ch.Path, u.ch.SHA); err != nil {
			return unavailable(err)
		}
	}
	for _, u := range configs {
		if u.ch.Status == 'D' {
			if _, err := tx.ExecContext(ctx, `DELETE FROM config_files WHERE path = $1`, u.ch.Path); err != nil {
				return unavailable(err)
			}
			continue
		}
		rec := extractConfig(u.m, u.ch.SHA, blobs[u.ch.SHA])
		if err := p.upsertConfig(ctx, tx, rec); err != nil {
			return err
		}
	}
	return nil
}

func (p *DB) upsertConfig(ctx context.Context, tx *sql.Tx, c *ConfigRecord) error {
	var data any
	if c.Data != nil {
		data = string(c.Data)
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO config_files (path, scope, scope_path, category, name, blob_sha, data, valid, error)
		VALUES ($1,$2,$3::ltree,$4,$5,$6,$7::jsonb,$8,$9)
		ON CONFLICT (path) DO UPDATE SET scope = EXCLUDED.scope, scope_path = EXCLUDED.scope_path, category = EXCLUDED.category,
		name = EXCLUDED.name, blob_sha = EXCLUDED.blob_sha, data = EXCLUDED.data, valid = EXCLUDED.valid, error = EXCLUDED.error`,
		c.Path, c.Scope, PathOf(c.Scope), c.Category, c.Name, c.BlobSHA, data, c.Valid, c.Error)
	return unavailable(err)
}

// upsertRecord writes an artifact row and its derived index rows, and
// maintains HID history. A file that claims a GUID already owned by a
// different, still existing file is recorded in file_issues instead of
// displacing the owner (GUIDs are permanent identities, §2.2.1).
func (p *DB) upsertRecord(ctx context.Context, tx *sql.Tx, r *record, commit string, when time.Time, removed map[string]bool) error {
	var oldHID sql.NullString
	var oldPath string
	var exists bool
	err := tx.QueryRowContext(ctx, `SELECT true, hid, file_path FROM artifacts WHERE guid = $1`, r.GUID).Scan(&exists, &oldHID, &oldPath)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return unavailable(err)
	}
	if exists && oldPath != r.Path && !removed[oldPath] {
		var owner string
		if err := tx.QueryRowContext(ctx, `SELECT error FROM artifacts WHERE guid = $1`, r.GUID).Scan(&owner); err != nil {
			return unavailable(err)
		}
		if owner != "not yet indexed" {
			_, err := tx.ExecContext(ctx, `INSERT INTO file_issues (path, guid, message) VALUES ($1,$2,$3)
				ON CONFLICT (path) DO UPDATE SET guid = EXCLUDED.guid, message = EXCLUDED.message`,
				r.Path, r.GUID, "claims GUID "+r.GUID+" which belongs to "+oldPath)
			return unavailable(err)
		}
		// The owner row is a not-yet-indexed identity row of a rebuild whose
		// file will be processed later; that file wins, this one is an issue.
		_, err := tx.ExecContext(ctx, `INSERT INTO file_issues (path, guid, message) VALUES ($1,$2,$3)
			ON CONFLICT (path) DO UPDATE SET guid = EXCLUDED.guid, message = EXCLUDED.message`,
			r.Path, r.GUID, "claims GUID "+r.GUID+" which belongs to "+oldPath)
		return unavailable(err)
	}
	var hid any
	if r.HID != "" {
		hid = r.HID
	}
	nullable := func(s string) any {
		if s == "" {
			return nil
		}
		return s
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO artifacts (guid, kind, type, title, hid, folder, path, file_path, blob_sha,
			base, source, target, subject, parent, author, created, states, fields, search_text, valid, error,
			created_at, modified_at, created_commit, modified_commit)
		VALUES ($1,$2,$3,$4,$5,$6,$7::ltree,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$22,$23,$23)
		ON CONFLICT (guid) DO UPDATE SET kind = EXCLUDED.kind, type = EXCLUDED.type, title = EXCLUDED.title, hid = EXCLUDED.hid,
			folder = EXCLUDED.folder, path = EXCLUDED.path, file_path = EXCLUDED.file_path, blob_sha = EXCLUDED.blob_sha,
			base = EXCLUDED.base, source = EXCLUDED.source, target = EXCLUDED.target, subject = EXCLUDED.subject, parent = EXCLUDED.parent,
			author = EXCLUDED.author, created = EXCLUDED.created, states = EXCLUDED.states, fields = EXCLUDED.fields,
			search_text = EXCLUDED.search_text, valid = EXCLUDED.valid, error = EXCLUDED.error,
			modified_at = EXCLUDED.modified_at, modified_commit = EXCLUDED.modified_commit`,
		r.GUID, string(r.Kind), r.Type, r.Title, hid, r.Folder, PathOf(r.Folder), r.Path, r.BlobSHA,
		nullable(r.Base), nullable(r.Source), nullable(r.Target), nullable(r.Subject), nullable(r.Parent),
		r.Author, r.Created, r.States, r.FieldsJ, r.Search, r.Valid, r.Error, when, commit)
	if err != nil {
		return unavailable(err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_fields WHERE guid = $1`, r.GUID); err != nil {
		return unavailable(err)
	}
	if err := insertFields(ctx, tx, r); err != nil {
		return err
	}
	// A resurrected GUID is no longer deleted.
	if _, err := tx.ExecContext(ctx, `DELETE FROM deleted_artifacts WHERE guid = $1`, r.GUID); err != nil {
		return unavailable(err)
	}
	// HID history (design guide §2.2.1).
	prev := oldHID.String
	if !exists || prev != r.HID {
		if exists && prev != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE hid_history SET until_commit = $1 WHERE guid = $2 AND hid = $3 AND until_commit IS NULL`, commit, r.GUID, prev); err != nil {
				return unavailable(err)
			}
		}
		if r.HID != "" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO hid_history (guid, hid, since_commit, since_at) VALUES ($1,$2,$3,$4)
				ON CONFLICT (guid, hid, since_commit) DO UPDATE SET until_commit = NULL, since_at = EXCLUDED.since_at`, r.GUID, r.HID, commit, when); err != nil {
				return unavailable(err)
			}
		}
	}
	return nil
}

func insertFields(ctx context.Context, tx *sql.Tx, r *record) error {
	seen := map[fieldKV]bool{}
	for _, kv := range r.Index {
		if seen[kv] {
			continue
		}
		seen[kv] = true
		if _, err := tx.ExecContext(ctx, `INSERT INTO artifact_fields (guid, field, value) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, r.GUID, kv.Field, kv.Value); err != nil {
			return unavailable(err)
		}
	}
	return nil
}

func (p *DB) deleteByPath(ctx context.Context, tx *sql.Tx, path, guid, commit string, when time.Time) error {
	rows, err := tx.QueryContext(ctx, `SELECT guid, kind, type, title, COALESCE(hid,''), file_path FROM artifacts WHERE file_path = $1 OR guid = $2`, path, guid)
	if err != nil {
		return unavailable(err)
	}
	type gone struct{ guid, kind, typ, title, hid, path string }
	var victims []gone
	for rows.Next() {
		var g gone
		if err := rows.Scan(&g.guid, &g.kind, &g.typ, &g.title, &g.hid, &g.path); err != nil {
			rows.Close()
			return unavailable(err)
		}
		victims = append(victims, g)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return unavailable(err)
	}
	for _, g := range victims {
		if g.path != path {
			continue // the GUID lives elsewhere now (moved in an earlier commit)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifacts WHERE guid = $1`, g.guid); err != nil {
			return unavailable(err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM artifact_files WHERE guid = $1`, g.guid); err != nil {
			return unavailable(err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE hid_history SET until_commit = $1 WHERE guid = $2 AND until_commit IS NULL`, commit, g.guid); err != nil {
			return unavailable(err)
		}
		var hid any
		if g.hid != "" {
			hid = g.hid
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO deleted_artifacts (guid, kind, type, title, hid, last_path, deleted_commit, deleted_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (guid) DO UPDATE SET kind = EXCLUDED.kind, type = EXCLUDED.type, title = EXCLUDED.title,
			hid = EXCLUDED.hid, last_path = EXCLUDED.last_path, deleted_commit = EXCLUDED.deleted_commit, deleted_at = EXCLUDED.deleted_at`,
			g.guid, g.kind, g.typ, g.title, hid, g.path, commit, when); err != nil {
			return unavailable(err)
		}
	}
	return nil
}

// promoteClaimants re-projects files that were waiting for a GUID whose
// owner has just been removed.
func (p *DB) promoteClaimants(ctx context.Context, tx *sql.Tx, guid, commit string, when time.Time, removed map[string]bool) error {
	rows, err := tx.QueryContext(ctx, `SELECT path FROM file_issues WHERE guid = $1 ORDER BY path`, guid)
	if err != nil {
		return unavailable(err)
	}
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return unavailable(err)
		}
		paths = append(paths, path)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return unavailable(err)
	}
	sc := p.Scanner()
	for _, path := range paths {
		if removed[path] {
			continue
		}
		content, sha, err := p.repo.ReadPath(ctx, commit, path)
		if err != nil {
			continue
		}
		m, ok := sc.Match(path)
		if !ok {
			continue
		}
		rec := extract(m, sha, content)
		if rec.GUID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM file_issues WHERE path = $1`, path); err != nil {
			return unavailable(err)
		}
		if err := p.upsertRecord(ctx, tx, rec, commit, when, removed); err != nil {
			return err
		}
	}
	return nil
}

// FileIssues lists files the projection could not accept (e.g. GUID conflicts).
func (p *DB) FileIssues(ctx context.Context) ([]Issue, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT path, guid, message FROM file_issues ORDER BY path`)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []Issue
	for rows.Next() {
		var i Issue
		if err := rows.Scan(&i.Path, &i.GUID, &i.Message); err != nil {
			return nil, unavailable(err)
		}
		i.Severity, i.Code = "error", "duplicate-guid"
		out = append(out, i)
	}
	return out, unavailable(rows.Err())
}

// ---- configuration cache --------------------------------------------------

type configCache struct {
	hash      string
	schemas   *model.SchemaIndex
	workflows *model.WorkflowIndex
	schemaSrc []model.ScopedSchema
}

func (p *DB) invalidateCache() {
	p.cacheMu.Lock()
	p.cache = nil
	p.cacheMu.Unlock()
}

// Config returns the schema and workflow indexes for the current projection
// state, cached per processed revision.
func (p *DB) Config(ctx context.Context) (*model.SchemaIndex, *model.WorkflowIndex, error) {
	hash, err := p.ProcessedHash(ctx)
	if err != nil {
		return nil, nil, err
	}
	p.cacheMu.Lock()
	if p.cache != nil && p.cache.hash == hash {
		c := p.cache
		p.cacheMu.Unlock()
		return c.schemas, c.workflows, nil
	}
	p.cacheMu.Unlock()
	// The result is shared by every request; one client giving up must not
	// abort (and thereby truncate) the query that fills it.
	qctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	rows, err := p.sql.QueryContext(qctx, `SELECT scope, category, name, data FROM config_files WHERE valid AND category IN ('schemas','workflows') ORDER BY scope, name`)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer rows.Close()
	var defs []model.ScopedSchema
	wfs := map[string][]*model.Workflow{}
	for rows.Next() {
		var scope, cat, name string
		var data []byte
		if err := rows.Scan(&scope, &cat, &name, &data); err != nil {
			return nil, nil, unavailable(err)
		}
		switch cat {
		case scanner.ConfigSchemas:
			s, err := model.ParseSchema(data)
			if err != nil {
				log.Printf("projection: schema %s/%s: %v", scope, name, err)
				continue
			}
			defs = append(defs, model.ScopedSchema{Scope: scope, Schema: s})
		case scanner.ConfigWorkflows:
			w, err := model.ParseWorkflow(data)
			if err != nil {
				log.Printf("projection: workflow %s/%s: %v", scope, name, err)
				continue
			}
			wfs[scope] = append(wfs[scope], w)
		}
	}
	if err := rows.Err(); err != nil {
		// A partial configuration must never be cached: every later request
		// would see schemas and workflows missing.
		return nil, nil, unavailable(err)
	}
	c := &configCache{hash: hash, schemas: model.NewSchemaIndex(defs), workflows: model.NewWorkflowIndex(wfs), schemaSrc: defs}
	p.cacheMu.Lock()
	p.cache = c
	p.cacheMu.Unlock()
	return c.schemas, c.workflows, nil
}
