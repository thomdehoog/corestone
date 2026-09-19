// Package projection is the PostgreSQL projection of a repository (design
// guide §3.10, §5.6–§5.16). It is never authoritative: every table can be
// rebuilt from Git, and the stored processed_hash says which revision the
// tables represent. Plain SQL only, no ORM.
package projection

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq" // PostgreSQL driver

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/scanner"
)

// DB is a projection bound to one Git repository and one database.
type DB struct {
	sql  *sql.DB
	repo *gitx.Repo

	// pubMu is the short-lived repository synchronization mutex of §10.1: it
	// is held only around "publish the commit, advance processed_hash".
	pubMu sync.Mutex
	// syncMu serializes replay/rebuild so two goroutines never rebuild at once.
	syncMu sync.Mutex

	stMu    sync.RWMutex
	status  Status
	scanner *scanner.Scanner

	cacheMu sync.Mutex
	cache   *configCache

	// Thresholds for maintenance mode during large structural operations.
	LargeOpThreshold int

	// OnStatus is invoked (asynchronously safe) whenever the status changes.
	OnStatus func(Status)
}

// Status is the projection's operational state, exposed by the API.
type Status struct {
	ProcessedHash string       `json:"processedHash"`
	Maintenance   bool         `json:"maintenance"`
	Reason        string       `json:"reason,omitempty"`
	Phase         string       `json:"phase,omitempty"`
	Progress      int          `json:"progress"`
	Total         int          `json:"total"`
	StartedAt     *time.Time   `json:"startedAt,omitempty"`
	LastRebuild   *time.Time   `json:"lastRebuild,omitempty"` // when the last full rebuild completed
	LastError     string       `json:"lastError,omitempty"`
	Capabilities  Capabilities `json:"capabilities"`
}

// Capabilities says which services are available while a rebuild runs.
type Capabilities struct {
	Lookup bool `json:"lookup"` // GUID → path (after reindex phase 1)
	Query  bool `json:"query"`  // metadata/field queries (after phase 2)
	Search bool `json:"search"` // full-text search (after phase 3)
}

// Ping checks that the projection database is reachable.
func (d *DB) Ping(ctx context.Context) error { return d.sql.PingContext(ctx) }

// Open connects to PostgreSQL, creates the tables if needed and loads the
// scanner configuration from the repository head.
func Open(ctx context.Context, dsn string, repo *gitx.Repo) (*DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(16)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("projection database: %w", err)
	}
	p := &DB{sql: db, repo: repo, LargeOpThreshold: 500, scanner: scanner.Default()}
	p.status.Capabilities = Capabilities{Lookup: true, Query: true, Search: true}
	if err := p.migrate(ctx); err != nil {
		db.Close()
		return nil, err
	}
	head, err := repo.Head(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	if err := p.loadScanner(ctx, head); err != nil {
		db.Close()
		return nil, err
	}
	ph, err := p.ProcessedHash(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	p.status.ProcessedHash = ph
	return p, nil
}

// Close releases the database.
func (p *DB) Close() error { return p.sql.Close() }

// Scanner returns the active repository scanner.
func (p *DB) Scanner() *scanner.Scanner {
	p.stMu.RLock()
	defer p.stMu.RUnlock()
	return p.scanner
}

func (p *DB) loadScanner(ctx context.Context, head string) error {
	cfg := scanner.DefaultConfig()
	if head != "" {
		data, _, err := p.repo.ReadPath(ctx, head, scanner.ConfigPath)
		if err != nil && !errors.Is(err, gitx.ErrNotFound) {
			return err
		}
		if err == nil {
			parsed, perr := scanner.ParseConfig(data)
			if perr != nil {
				p.setStatus(func(s *Status) { s.LastError = perr.Error() })
			} else {
				cfg = parsed
			}
		}
	}
	p.stMu.Lock()
	p.scanner = scanner.New(cfg)
	p.stMu.Unlock()
	return nil
}

// Status returns a snapshot of the projection state.
func (p *DB) Status() Status {
	p.stMu.RLock()
	defer p.stMu.RUnlock()
	return p.status
}

func (p *DB) setStatus(f func(*Status)) {
	p.stMu.Lock()
	f(&p.status)
	s := p.status
	cb := p.OnStatus
	p.stMu.Unlock()
	if cb != nil {
		cb(s)
	}
}

// Maintenance reports whether writes are currently blocked.
func (p *DB) Maintenance() bool {
	p.stMu.RLock()
	defer p.stMu.RUnlock()
	return p.status.Maintenance
}

// EnterMaintenance blocks writes for a large structural operation (§10.2).
// It returns false when maintenance mode is already active.
func (p *DB) EnterMaintenance(reason string) bool {
	p.stMu.Lock()
	if p.status.Maintenance {
		p.stMu.Unlock()
		return false
	}
	now := time.Now()
	p.status.Maintenance, p.status.Reason, p.status.StartedAt = true, reason, &now
	p.status.Phase, p.status.Progress, p.status.Total = "", 0, 0
	s := p.status
	cb := p.OnStatus
	p.stMu.Unlock()
	// Advertise maintenance to other server processes sharing the database.
	_, _ = p.sql.Exec(`UPDATE repo_state SET maintenance = $1 WHERE id = 1`, reason)
	if cb != nil {
		cb(s)
	}
	return true
}

// LeaveMaintenance restores normal operation.
func (p *DB) LeaveMaintenance() {
	_, _ = p.sql.Exec(`UPDATE repo_state SET maintenance = '' WHERE id = 1`)
	p.setStatus(func(s *Status) {
		s.Maintenance, s.Reason, s.Phase, s.StartedAt = false, "", "", nil
		s.Progress, s.Total = 0, 0
		s.Capabilities = Capabilities{Lookup: true, Query: true, Search: true}
	})
}

// RemoteMaintenance reports the maintenance reason recorded in the
// database by any server process ("" when none).
func (p *DB) RemoteMaintenance(ctx context.Context) (string, error) {
	var reason string
	err := p.sql.QueryRowContext(ctx, `SELECT maintenance FROM repo_state WHERE id = 1`).Scan(&reason)
	return reason, unavailable(err)
}

// PublishMutex is the §10.1 synchronization mutex.
func (p *DB) PublishMutex() *sync.Mutex { return &p.pubMu }

// Begin starts a projection transaction.
func (p *DB) Begin(ctx context.Context) (*sql.Tx, error) {
	return p.sql.BeginTx(ctx, nil)
}

// SQL exposes the connection for tests and maintenance tooling.
func (p *DB) SQL() *sql.DB { return p.sql }

// ProcessedHash returns the revision the projection represents ("" = none).
func (p *DB) ProcessedHash(ctx context.Context) (string, error) {
	var h string
	err := p.sql.QueryRowContext(ctx, `SELECT processed_hash FROM repo_state WHERE id = 1`).Scan(&h)
	if err != nil {
		return "", unavailable(err)
	}
	return h, nil
}

// AdvanceProcessed moves processed_hash from `from` to `to` inside tx with a
// compare-and-swap; false means another writer got there first.
func (p *DB) AdvanceProcessed(ctx context.Context, tx *sql.Tx, from, to string) (bool, error) {
	res, err := tx.ExecContext(ctx, `UPDATE repo_state SET processed_hash = $1, updated_at = now() WHERE id = 1 AND processed_hash = $2`, to, from)
	if err != nil {
		return false, unavailable(err)
	}
	n, _ := res.RowsAffected()
	if n == 1 {
		p.setStatus(func(s *Status) { s.ProcessedHash = to })
		p.invalidateCache()
	}
	return n == 1, nil
}

func unavailable(err error) error {
	if err == nil {
		return nil
	}
	// Keep the cause visible to errors.Is: a cancelled request must be
	// reported as such, not as an outage. PostgreSQL reports a statement
	// cancelled through the context as SQLSTATE 57014 (query_canceled).
	var pqErr *pq.Error
	if errors.As(err, &pqErr) && pqErr.Code == "57014" {
		return fmt.Errorf("%w: projection: %w (%v)", model.ErrUnavailable, context.Canceled, err)
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("%w: projection: %w", model.ErrUnavailable, err)
	}
	return fmt.Errorf("%w: projection: %v", model.ErrUnavailable, err)
}

// ---- schema ---------------------------------------------------------------

var ddl = []string{
	`CREATE EXTENSION IF NOT EXISTS ltree`,
	`CREATE TABLE IF NOT EXISTS repo_state (
		id smallint PRIMARY KEY CHECK (id = 1),
		processed_hash text NOT NULL DEFAULT '',
		updated_at timestamptz NOT NULL DEFAULT now())`,
	`INSERT INTO repo_state (id) VALUES (1) ON CONFLICT DO NOTHING`,
	`ALTER TABLE repo_state ADD COLUMN IF NOT EXISTS maintenance text NOT NULL DEFAULT ''`,
	`CREATE TABLE IF NOT EXISTS artifacts (
		guid text PRIMARY KEY,
		kind text NOT NULL,
		type text NOT NULL DEFAULT '',
		title text NOT NULL DEFAULT '',
		hid text,
		folder text NOT NULL DEFAULT '',
		path ltree NOT NULL,
		file_path text NOT NULL,
		blob_sha text NOT NULL,
		base text, source text, target text, subject text, parent text,
		author text NOT NULL DEFAULT '',
		created text NOT NULL DEFAULT '',
		states jsonb NOT NULL DEFAULT '{}'::jsonb,
		fields jsonb NOT NULL DEFAULT '{}'::jsonb,
		search_text text NOT NULL DEFAULT '',
		tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', left(search_text, 100000))) STORED,
		valid boolean NOT NULL DEFAULT true,
		error text NOT NULL DEFAULT '',
		created_at timestamptz, modified_at timestamptz,
		created_commit text, modified_commit text)`,
	`CREATE INDEX IF NOT EXISTS artifacts_path_gist ON artifacts USING GIST (path)`,
	`CREATE INDEX IF NOT EXISTS artifacts_folder ON artifacts (folder)`,
	`CREATE INDEX IF NOT EXISTS artifacts_kind_type ON artifacts (kind, type)`,
	`CREATE INDEX IF NOT EXISTS artifacts_hid ON artifacts (hid)`,
	`CREATE INDEX IF NOT EXISTS artifacts_source ON artifacts (source) WHERE source IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS artifacts_target ON artifacts (target) WHERE target IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS artifacts_subject ON artifacts (subject) WHERE subject IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS artifacts_base ON artifacts (base) WHERE base IS NOT NULL`,
	`CREATE INDEX IF NOT EXISTS artifacts_file_path ON artifacts (file_path)`,
	`CREATE INDEX IF NOT EXISTS artifacts_tsv ON artifacts USING GIN (tsv)`,
	`CREATE TABLE IF NOT EXISTS artifact_fields (
		guid text NOT NULL REFERENCES artifacts (guid) ON DELETE CASCADE,
		field text NOT NULL,
		value text NOT NULL,
		PRIMARY KEY (guid, field, value))`,
	`CREATE INDEX IF NOT EXISTS artifact_fields_lookup ON artifact_fields (field, value)`,
	`CREATE TABLE IF NOT EXISTS artifact_files (
		guid text NOT NULL,
		name text NOT NULL,
		path text NOT NULL,
		blob_sha text NOT NULL,
		size bigint NOT NULL DEFAULT 0,
		PRIMARY KEY (guid, name))`,
	`CREATE TABLE IF NOT EXISTS config_files (
		path text PRIMARY KEY,
		scope text NOT NULL DEFAULT '',
		scope_path ltree NOT NULL,
		category text NOT NULL,
		name text NOT NULL,
		blob_sha text NOT NULL,
		data jsonb,
		valid boolean NOT NULL DEFAULT true,
		error text NOT NULL DEFAULT '')`,
	`CREATE INDEX IF NOT EXISTS config_files_category ON config_files (category, scope)`,
	`CREATE TABLE IF NOT EXISTS hid_history (
		guid text NOT NULL,
		hid text NOT NULL,
		since_commit text NOT NULL DEFAULT '',
		since_at timestamptz,
		until_commit text,
		PRIMARY KEY (guid, hid, since_commit))`,
	`CREATE INDEX IF NOT EXISTS hid_history_hid ON hid_history (hid)`,
	`CREATE TABLE IF NOT EXISTS file_issues (
		path text PRIMARY KEY,
		guid text NOT NULL,
		message text NOT NULL)`,
	`CREATE INDEX IF NOT EXISTS file_issues_guid ON file_issues (guid)`,
	`CREATE TABLE IF NOT EXISTS deleted_artifacts (
		guid text PRIMARY KEY,
		kind text NOT NULL,
		type text NOT NULL DEFAULT '',
		title text NOT NULL DEFAULT '',
		hid text,
		last_path text NOT NULL,
		deleted_commit text NOT NULL,
		deleted_at timestamptz)`,
}

func (p *DB) migrate(ctx context.Context) error {
	for _, stmt := range ddl {
		if _, err := p.sql.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("projection schema: %w (statement: %.60s)", err, stmt)
		}
	}
	return nil
}

// ---- hierarchy encoding ---------------------------------------------------

// LabelOf encodes a folder name as an ltree label: alphanumerics pass
// through, every other byte becomes "_" + two hex digits, and over-long
// names are shortened with a hash. Encoding is exact, so hierarchy queries
// never see collisions between distinct folder names.
func LabelOf(seg string) string {
	var b strings.Builder
	for i := 0; i < len(seg); i++ {
		c := seg[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
			b.WriteString(hex.EncodeToString([]byte{c}))
		}
	}
	s := b.String()
	if len(s) > 200 {
		sum := sha1.Sum([]byte(seg))
		s = s[:160] + "_h" + hex.EncodeToString(sum[:])
	}
	return s
}

// PathOf encodes a folder path as an ltree path ("" for the root).
func PathOf(folder string) string {
	if folder == "" {
		return ""
	}
	segs := strings.Split(folder, "/")
	for i := range segs {
		segs[i] = LabelOf(segs[i])
	}
	return strings.Join(segs, ".")
}

// Located is the GUID → path translation of one artifact.
type Located struct {
	GUID     string
	Kind     model.Kind
	Type     string
	Folder   string
	FilePath string
	BlobSHA  string
	Valid    bool
}
