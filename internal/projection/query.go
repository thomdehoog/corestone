package projection

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/thomdehoog/corestone/internal/model"
)

// Query describes a search / filter request (design guide §5.10, §7.4).
type Query struct {
	Text    string
	Kinds   []model.Kind
	Type    string
	Folder  string
	Subtree bool
	HID     string
	Fields  map[string]string // field id -> exact value
	States  map[string]string // workflow id -> state
	Valid   *bool
	Sort    string // "modified" (default), "title", "hid", "path", "created"
	Limit   int
	Offset  int
}

const (
	DefaultLimit = 200
	MaxLimit     = 5000
)

const summaryCols = `a.guid, a.kind, a.type, a.title, COALESCE(a.hid,''), a.folder, a.file_path, COALESCE(a.base,''),
	COALESCE(a.source,''), COALESCE(a.target,''), COALESCE(a.subject,''), COALESCE(a.parent,''), a.author, a.created,
	a.states, a.fields, a.blob_sha, a.created_at, a.modified_at,
	(SELECT count(*) FROM artifacts l WHERE l.kind = 'link' AND (l.source = a.guid OR l.target = a.guid)),
	(SELECT count(*) FROM artifacts c WHERE c.kind = 'comment' AND c.subject = a.guid)`

func scanSummary(rows interface{ Scan(...any) error }) (*model.Summary, error) {
	var s model.Summary
	var kind, states, fields string
	var createdAt, modifiedAt sql.NullTime
	if err := rows.Scan(&s.GUID, &kind, &s.Type, &s.Title, &s.HID, &s.Folder, &s.Path, &s.Base, &s.Source, &s.Target,
		&s.Subject, &s.Parent, &s.Author, &s.Created, &states, &fields, &s.ETag, &createdAt, &modifiedAt, &s.Links, &s.Comments); err != nil {
		return nil, err
	}
	s.Kind = model.Kind(kind)
	if states != "" && states != "{}" {
		_ = json.Unmarshal([]byte(states), &s.Workflows)
	}
	if fields != "" && fields != "{}" {
		_ = json.Unmarshal([]byte(fields), &s.Fields)
	}
	if createdAt.Valid {
		t := createdAt.Time.UTC()
		s.CreatedAt = &t
	}
	if modifiedAt.Valid {
		t := modifiedAt.Time.UTC()
		s.ModifiedAt = &t
	}
	return &s, nil
}

// Locate translates a GUID to its repository location (design guide §5.7).
func (p *DB) Locate(ctx context.Context, guid string) (*Located, error) {
	if !model.IsGUID(guid) {
		return nil, model.ErrNotFound
	}
	var l Located
	var kind string
	err := p.sql.QueryRowContext(ctx, `SELECT guid, kind, type, folder, file_path, blob_sha, valid FROM artifacts WHERE guid = $1`, guid).
		Scan(&l.GUID, &kind, &l.Type, &l.Folder, &l.FilePath, &l.BlobSHA, &l.Valid)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, model.ErrNotFound
	}
	if err != nil {
		return nil, unavailable(err)
	}
	l.Kind = model.Kind(kind)
	return &l, nil
}

// Get returns the projected summary of one artifact.
func (p *DB) Get(ctx context.Context, guid string) (*model.Summary, error) {
	if !model.IsGUID(guid) {
		return nil, model.ErrNotFound
	}
	row := p.sql.QueryRowContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.guid = $1`, guid)
	s, err := scanSummary(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, model.ErrNotFound
	}
	if err != nil {
		return nil, unavailable(err)
	}
	return s, nil
}

// Search runs a filtered, optionally full-text query.
func (p *DB) Search(ctx context.Context, q Query) ([]*model.Summary, int, error) {
	if q.Text != "" && !p.Status().Capabilities.Search {
		return nil, 0, fmt.Errorf("%w: full-text search is being rebuilt", model.ErrUnavailable)
	}
	if !p.Status().Capabilities.Query {
		return nil, 0, fmt.Errorf("%w: projection is being rebuilt", model.ErrUnavailable)
	}
	q.Text, q.Type, q.HID, q.Sort = clean(q.Text), clean(q.Type), clean(q.HID), clean(q.Sort)
	for k, v := range q.Fields {
		q.Fields[k] = clean(v)
	}
	for k, v := range q.States {
		q.States[k] = clean(v)
	}
	var where []string
	var args []any
	arg := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	if len(q.Kinds) > 0 {
		var ks []string
		for _, k := range q.Kinds {
			ks = append(ks, arg(string(k)))
		}
		where = append(where, "a.kind IN ("+strings.Join(ks, ",")+")")
	}
	if q.Type != "" {
		where = append(where, "a.type = "+arg(q.Type))
	}
	if q.HID != "" {
		where = append(where, "a.hid = "+arg(q.HID))
	}
	if q.Folder != "" || !q.Subtree {
		if q.Subtree {
			where = append(where, "a.path <@ "+arg(PathOf(q.Folder))+"::ltree")
		} else {
			where = append(where, "a.folder = "+arg(q.Folder))
		}
	}
	for f, v := range q.Fields {
		where = append(where, "EXISTS (SELECT 1 FROM artifact_fields f WHERE f.guid = a.guid AND f.field = "+arg(clean(f))+" AND f.value = "+arg(v)+")")
	}
	for w, st := range q.States {
		where = append(where, "a.states->>"+arg(clean(w))+" = "+arg(st))
	}
	if q.Valid != nil {
		where = append(where, "a.valid = "+arg(*q.Valid))
	}
	order := "a.modified_at DESC NULLS LAST, a.file_path"
	text := strings.TrimSpace(q.Text)
	if text != "" {
		t := arg(text)
		like := arg("%" + escapeLike(text) + "%")
		where = append(where, "(a.tsv @@ plainto_tsquery('simple', "+t+") OR a.hid ILIKE "+like+" OR a.title ILIKE "+like+")")
		order = "ts_rank(a.tsv, plainto_tsquery('simple', " + t + ")) DESC, " + order
	}
	switch q.Sort {
	case "title":
		order = "lower(a.title), a.file_path"
	case "hid":
		order = "a.hid NULLS LAST, a.file_path"
	case "path":
		order = "a.file_path"
	case "created":
		order = "a.created_at DESC NULLS LAST, a.file_path"
	}
	limit := q.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}
	sqlWhere := ""
	if len(where) > 0 {
		sqlWhere = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := p.sql.QueryRowContext(ctx, `SELECT count(*) FROM artifacts a`+sqlWhere, args...).Scan(&total); err != nil {
		return nil, 0, unavailable(err)
	}
	stmt := `SELECT ` + summaryCols + ` FROM artifacts a` + sqlWhere + ` ORDER BY ` + order +
		` LIMIT ` + arg(limit) + ` OFFSET ` + arg(max(q.Offset, 0))
	rows, err := p.sql.QueryContext(ctx, stmt, args...)
	if err != nil {
		return nil, 0, unavailable(err)
	}
	defer rows.Close()
	var out []*model.Summary
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, 0, unavailable(err)
		}
		out = append(out, s)
	}
	return out, total, unavailable(rows.Err())
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// FolderInfo is one child folder in a tree listing.
type FolderInfo struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Artifacts int    `json:"artifacts"` // entries + documents anywhere below
	Direct    int    `json:"direct"`    // entries + documents in the folder itself
	HasConfig bool   `json:"hasConfig"` // owns a metadata directory
}

// Folders lists the immediate child folders of a folder, derived from
// artifact locations and configuration scopes (design guide §5.8).
func (p *DB) Folders(ctx context.Context, folder string) ([]FolderInfo, error) {
	depth := 0
	if folder != "" {
		depth = strings.Count(folder, "/") + 1
	}
	rows, err := p.sql.QueryContext(ctx, `
		SELECT child, sum(n)::int, sum(d)::int, bool_or(cfg) FROM (
			SELECT split_part(folder, '/', $2) AS child, count(*) AS n,
			       count(*) FILTER (WHERE nlevel(path) = $3 + 1) AS d, false AS cfg
			  FROM artifacts WHERE path <@ $1::ltree AND nlevel(path) > $3 AND kind IN ('entry','document') GROUP BY 1
			UNION ALL
			SELECT split_part(scope, '/', $2), 0, 0, true
			  FROM config_files WHERE scope_path <@ $1::ltree AND nlevel(scope_path) > $3
			UNION ALL
			SELECT split_part(folder, '/', $2), 0, 0, true
			  FROM artifacts WHERE path <@ $1::ltree AND nlevel(path) > $3 AND kind IN ('link','comment')
		) c WHERE child <> '' GROUP BY child ORDER BY lower(child)`, PathOf(folder), depth+1, depth)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []FolderInfo
	for rows.Next() {
		var f FolderInfo
		if err := rows.Scan(&f.Name, &f.Artifacts, &f.Direct, &f.HasConfig); err != nil {
			return nil, unavailable(err)
		}
		f.Path = f.Name
		if folder != "" {
			f.Path = folder + "/" + f.Name
		}
		out = append(out, f)
	}
	return out, unavailable(rows.Err())
}

// Scopes lists every folder that owns a metadata directory.
func (p *DB) Scopes(ctx context.Context) ([]string, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT scope FROM config_files UNION SELECT folder FROM artifacts WHERE kind IN ('link','comment')`)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, unavailable(err)
		}
		out = append(out, s)
	}
	sort.Strings(out)
	return out, unavailable(rows.Err())
}

// NearestScope returns the closest folder at or above `folder` that owns a
// metadata directory; the root when none exists (design guide §3.4).
func (p *DB) NearestScope(ctx context.Context, folder string) (string, error) {
	scopes, err := p.Scopes(ctx)
	if err != nil {
		return "", err
	}
	set := map[string]bool{}
	for _, s := range scopes {
		set[s] = true
	}
	for _, a := range model.Ancestors(folder) {
		if set[a] {
			return a, nil
		}
	}
	return "", nil
}

// HIDOwner returns the GUID currently carrying a HID ("" if free).
func (p *DB) HIDOwner(ctx context.Context, hid string) (string, error) {
	hid = clean(hid)
	var guid string
	err := p.sql.QueryRowContext(ctx, `SELECT guid FROM artifacts WHERE hid = $1 LIMIT 1`, hid).Scan(&guid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return guid, unavailable(err)
}

// NextHIDNumber returns one more than the highest number ever used with a
// prefix (current and historical HIDs), so generated HIDs never repeat.
func (p *DB) NextHIDNumber(ctx context.Context, prefix string) (int, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT hid FROM artifacts WHERE hid LIKE $1 UNION SELECT hid FROM hid_history WHERE hid LIKE $1 UNION SELECT hid FROM deleted_artifacts WHERE hid LIKE $1`,
		escapeLike(prefix)+"%")
	if err != nil {
		return 0, unavailable(err)
	}
	defer rows.Close()
	maxN := 0
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return 0, unavailable(err)
		}
		if n, err := strconv.Atoi(strings.TrimPrefix(h, prefix)); err == nil && n > maxN {
			maxN = n
		}
	}
	return maxN + 1, unavailable(rows.Err())
}

// LinksOf lists links pointing at or away from an artifact.
func (p *DB) LinksOf(ctx context.Context, guid string) (incoming, outgoing []*model.Summary, err error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.kind = 'link' AND (a.source = $1 OR a.target = $1) ORDER BY a.type, a.file_path`, guid)
	if err != nil {
		return nil, nil, unavailable(err)
	}
	defer rows.Close()
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, nil, unavailable(err)
		}
		if s.Source == guid {
			outgoing = append(outgoing, s)
		}
		if s.Target == guid {
			incoming = append(incoming, s)
		}
	}
	return incoming, outgoing, unavailable(rows.Err())
}

// CountLinks counts links of a type from a source and/or to a target.
func (p *DB) CountLinks(ctx context.Context, linkType, source, target string) (int, error) {
	var n int
	err := p.sql.QueryRowContext(ctx, `SELECT count(*) FROM artifacts WHERE kind = 'link' AND type = $1 AND ($2 = '' OR source = $2) AND ($3 = '' OR target = $3)`,
		linkType, source, target).Scan(&n)
	return n, unavailable(err)
}

// FindLink returns a link of a type between two artifacts, if any.
func (p *DB) FindLink(ctx context.Context, linkType, source, target string) (string, error) {
	var guid string
	err := p.sql.QueryRowContext(ctx, `SELECT guid FROM artifacts WHERE kind = 'link' AND type = $1 AND source = $2 AND target = $3 LIMIT 1`, linkType, source, target).Scan(&guid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return guid, unavailable(err)
}

// CommentsOf lists the comments on an artifact in chronological order.
func (p *DB) CommentsOf(ctx context.Context, guid string) ([]*model.Summary, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.kind = 'comment' AND a.subject = $1 ORDER BY a.created, a.file_path`, guid)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []*model.Summary
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, unavailable(err)
		}
		out = append(out, s)
	}
	return out, unavailable(rows.Err())
}

// MetadataOf lists links and comments attached to any of the GUIDs (links
// by source or target, comments by subject), e.g. for cascading deletes.
func (p *DB) MetadataOf(ctx context.Context, guids []string) ([]*model.Summary, error) {
	if len(guids) == 0 {
		return nil, nil
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.kind IN ('link','comment')
		AND (a.source = ANY($1) OR a.target = ANY($1) OR a.subject = ANY($1)) ORDER BY a.file_path`, pqArray(guids))
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []*model.Summary
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, unavailable(err)
		}
		out = append(out, s)
	}
	return out, unavailable(rows.Err())
}

// Overlays lists entries whose base is the given entry.
func (p *DB) Overlays(ctx context.Context, guid string) ([]*model.Summary, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.base = $1 ORDER BY a.file_path`, guid)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []*model.Summary
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, unavailable(err)
		}
		out = append(out, s)
	}
	return out, unavailable(rows.Err())
}

// Referrers lists documents and entries that reference a GUID in their
// content or reference fields (by search of the fields index / content).
func (p *DB) Referrers(ctx context.Context, guid string) ([]*model.Summary, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.kind IN ('entry','document') AND a.guid <> $1
		AND (EXISTS (SELECT 1 FROM artifact_fields f WHERE f.guid = a.guid AND f.value = $1) OR a.search_text LIKE $2) ORDER BY a.file_path LIMIT 500`,
		guid, "%"+guid+"%")
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []*model.Summary
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, unavailable(err)
		}
		out = append(out, s)
	}
	return out, unavailable(rows.Err())
}

// PathEntry is one repository file belonging to a folder subtree.
type PathEntry struct {
	Path string
	GUID string // owning artifact, if any
	Kind string // "artifact", "attachment", "config"
}

// FilesUnder lists every projected file inside a folder subtree (artifact
// files, attachments, configuration and metadata), for restructuring.
func (p *DB) FilesUnder(ctx context.Context, folder string) ([]PathEntry, error) {
	lt := PathOf(folder)
	var out []PathEntry
	rows, err := p.sql.QueryContext(ctx, `SELECT file_path, guid FROM artifacts WHERE path <@ $1::ltree ORDER BY file_path`, lt)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var e PathEntry
		if err := rows.Scan(&e.Path, &e.GUID); err != nil {
			rows.Close()
			return nil, unavailable(err)
		}
		e.Kind = "artifact"
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	rows, err = p.sql.QueryContext(ctx, `SELECT f.path, f.guid FROM artifact_files f JOIN artifacts a ON a.guid = f.guid WHERE a.path <@ $1::ltree ORDER BY f.path`, lt)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var e PathEntry
		if err := rows.Scan(&e.Path, &e.GUID); err != nil {
			rows.Close()
			return nil, unavailable(err)
		}
		e.Kind = "attachment"
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	rows, err = p.sql.QueryContext(ctx, `SELECT path FROM config_files WHERE scope_path <@ $1::ltree ORDER BY path`, lt)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var e PathEntry
		if err := rows.Scan(&e.Path); err != nil {
			rows.Close()
			return nil, unavailable(err)
		}
		e.Kind = "config"
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	return out, nil
}

// Attachment is a file stored inside an artifact's GUID directory.
type Attachment struct {
	Name string `json:"name"`
	Path string `json:"path"`
	ETag string `json:"etag"`
	Size int64  `json:"size"`
}

// Attachments lists the extra files of an artifact.
func (p *DB) Attachments(ctx context.Context, guid string) ([]Attachment, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT name, path, blob_sha, size FROM artifact_files WHERE guid = $1 ORDER BY name`, guid)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	out := []Attachment{}
	for rows.Next() {
		var a Attachment
		if err := rows.Scan(&a.Name, &a.Path, &a.ETag, &a.Size); err != nil {
			return nil, unavailable(err)
		}
		out = append(out, a)
	}
	return out, unavailable(rows.Err())
}

// ConfigFiles lists projected configuration files of a category, optionally
// limited to one scope.
func (p *DB) ConfigFiles(ctx context.Context, category, scope string, allScopes bool) ([]ConfigRecord, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT path, scope, category, name, blob_sha, data, valid, error FROM config_files
		WHERE category = $1 AND ($3 OR scope = $2) ORDER BY scope, name`, category, scope, allScopes)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	out := []ConfigRecord{}
	for rows.Next() {
		var c ConfigRecord
		var data []byte
		if err := rows.Scan(&c.Path, &c.Scope, &c.Category, &c.Name, &c.BlobSHA, &data, &c.Valid, &c.Error); err != nil {
			return nil, unavailable(err)
		}
		c.Data = data
		out = append(out, c)
	}
	return out, unavailable(rows.Err())
}

// HIDRecord is one entry of the HID history.
type HIDRecord struct {
	GUID        string     `json:"guid"`
	HID         string     `json:"hid"`
	SinceCommit string     `json:"sinceCommit,omitempty"`
	SinceAt     *time.Time `json:"sinceAt,omitempty"`
	UntilCommit string     `json:"untilCommit,omitempty"`
	Current     bool       `json:"current"`
}

// HIDHistory lists every artifact that ever carried a HID, and the
// history of HIDs of a GUID when guid is given (design guide §2.2.1).
func (p *DB) HIDHistory(ctx context.Context, hid, guid string) ([]HIDRecord, error) {
	hid, guid = clean(hid), clean(guid)
	rows, err := p.sql.QueryContext(ctx, `SELECT h.guid, h.hid, h.since_commit, h.since_at, COALESCE(h.until_commit,''),
		EXISTS (SELECT 1 FROM artifacts a WHERE a.guid = h.guid AND a.hid = h.hid)
		FROM hid_history h WHERE ($1 = '' OR h.hid = $1) AND ($2 = '' OR h.guid = $2) ORDER BY h.since_at DESC NULLS LAST`, hid, guid)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	out := []HIDRecord{}
	for rows.Next() {
		var r HIDRecord
		var at sql.NullTime
		if err := rows.Scan(&r.GUID, &r.HID, &r.SinceCommit, &at, &r.UntilCommit, &r.Current); err != nil {
			return nil, unavailable(err)
		}
		if at.Valid {
			t := at.Time.UTC()
			r.SinceAt = &t
		}
		out = append(out, r)
	}
	return out, unavailable(rows.Err())
}

// DeletedArtifact is a projected record of a removed artifact (§5.16).
type DeletedArtifact struct {
	GUID          string     `json:"guid"`
	Kind          string     `json:"kind"`
	Type          string     `json:"type"`
	Title         string     `json:"title"`
	HID           string     `json:"hid,omitempty"`
	LastPath      string     `json:"lastPath"`
	DeletedCommit string     `json:"deletedCommit"`
	DeletedAt     *time.Time `json:"deletedAt,omitempty"`
}

// Deleted lists deleted artifacts, newest first.
func (p *DB) Deleted(ctx context.Context, guid string, limit int) ([]DeletedArtifact, error) {
	if limit <= 0 || limit > MaxLimit {
		limit = DefaultLimit
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT guid, kind, type, title, COALESCE(hid,''), last_path, deleted_commit, deleted_at FROM deleted_artifacts
		WHERE $1 = '' OR guid = $1 ORDER BY deleted_at DESC NULLS LAST LIMIT $2`, guid, limit)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	out := []DeletedArtifact{}
	for rows.Next() {
		var d DeletedArtifact
		var at sql.NullTime
		if err := rows.Scan(&d.GUID, &d.Kind, &d.Type, &d.Title, &d.HID, &d.LastPath, &d.DeletedCommit, &at); err != nil {
			return nil, unavailable(err)
		}
		if at.Valid {
			t := at.Time.UTC()
			d.DeletedAt = &t
		}
		out = append(out, d)
	}
	return out, unavailable(rows.Err())
}

// Stats are repository statistics (design guide §3.10).
type Stats struct {
	Artifacts map[string]int `json:"artifacts"` // per kind
	Types     map[string]int `json:"types"`     // per type
	Invalid   int            `json:"invalid"`
	Deleted   int            `json:"deleted"`
	Folders   int            `json:"folders"`
	Schemas   int            `json:"schemas"`
	Workflows int            `json:"workflows"`
}

// Stats computes repository statistics from the projection.
func (p *DB) Stats(ctx context.Context) (*Stats, error) {
	st := &Stats{Artifacts: map[string]int{}, Types: map[string]int{}}
	rows, err := p.sql.QueryContext(ctx, `SELECT kind, type, count(*) FROM artifacts GROUP BY kind, type`)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var k, t string
		var n int
		if err := rows.Scan(&k, &t, &n); err != nil {
			rows.Close()
			return nil, unavailable(err)
		}
		st.Artifacts[k] += n
		st.Types[t] += n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	err = p.sql.QueryRowContext(ctx, `SELECT
		(SELECT count(*) FROM artifacts WHERE NOT valid),
		(SELECT count(*) FROM deleted_artifacts),
		(SELECT count(DISTINCT folder) FROM artifacts WHERE folder <> ''),
		(SELECT count(*) FROM config_files WHERE category = 'schemas'),
		(SELECT count(*) FROM config_files WHERE category = 'workflows')`).
		Scan(&st.Invalid, &st.Deleted, &st.Folders, &st.Schemas, &st.Workflows)
	return st, unavailable(err)
}

// TypesInUse lists artifact types with counts, optionally within a subtree.
func (p *DB) TypesInUse(ctx context.Context, folder string) (map[string]map[string]int, error) {
	rows, err := p.sql.QueryContext(ctx, `SELECT kind, type, count(*) FROM artifacts WHERE path <@ $1::ltree GROUP BY kind, type ORDER BY kind, type`, PathOf(folder))
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	out := map[string]map[string]int{}
	for rows.Next() {
		var k, t string
		var n int
		if err := rows.Scan(&k, &t, &n); err != nil {
			return nil, unavailable(err)
		}
		if out[k] == nil {
			out[k] = map[string]int{}
		}
		out[k][t] = n
	}
	return out, unavailable(rows.Err())
}

// pqArray formats a text[] literal for lib/pq.
func pqArray(items []string) string {
	quoted := make([]string, len(items))
	for i, s := range items {
		quoted[i] = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
	}
	return "{" + strings.Join(quoted, ",") + "}"
}

// Replies lists comments whose parent is any of the given comments.
func (p *DB) Replies(ctx context.Context, parents []string) ([]*model.Summary, error) {
	if len(parents) == 0 {
		return nil, nil
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT `+summaryCols+` FROM artifacts a WHERE a.kind = 'comment' AND a.parent = ANY($1) ORDER BY a.created`, pqArray(parents))
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []*model.Summary
	for rows.Next() {
		s, err := scanSummary(rows)
		if err != nil {
			return nil, unavailable(err)
		}
		out = append(out, s)
	}
	return out, unavailable(rows.Err())
}
