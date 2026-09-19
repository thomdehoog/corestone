package projection

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/thomdehoog/corestone/internal/model"
)

// Issue is one finding of the repository validation service.
type Issue struct {
	Severity string `json:"severity"` // "error" | "warning"
	Code     string `json:"code"`
	GUID     string `json:"guid,omitempty"`
	Path     string `json:"path,omitempty"`
	Message  string `json:"message"`
}

// Validate checks the repository invariants of design guide §3.17 across
// the projection: reference integrity, HID uniqueness, overlay acyclicity,
// metadata locality, workflow consistency and file validity.
func (p *DB) Validate(ctx context.Context) ([]Issue, error) {
	var issues []Issue
	add := func(sev, code, guid, path, msg string) {
		issues = append(issues, Issue{sev, code, guid, path, msg})
	}

	rows, err := p.sql.QueryContext(ctx, `SELECT guid, file_path, error FROM artifacts WHERE NOT valid OR error <> '' ORDER BY file_path`)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var g, path, e string
		_ = rows.Scan(&g, &path, &e)
		add("error", "invalid-artifact", g, path, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}

	fileIssues, err := p.FileIssues(ctx)
	if err != nil {
		return nil, err
	}
	issues = append(issues, fileIssues...)

	rows, err = p.sql.QueryContext(ctx, `SELECT path, error FROM config_files WHERE NOT valid ORDER BY path`)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var path, e string
		_ = rows.Scan(&path, &e)
		add("error", "invalid-config", "", path, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}

	rows, err = p.sql.QueryContext(ctx, `SELECT hid, count(*), array_to_string(array_agg(guid), ',') FROM artifacts WHERE hid IS NOT NULL GROUP BY hid HAVING count(*) > 1`)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var hid, guids string
		var n int
		_ = rows.Scan(&hid, &n, &guids)
		add("error", "duplicate-hid", "", "", "HID "+hid+" is used by "+guids)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}

	// dangling references
	for _, q := range []struct{ col, code, kind string }{
		{"source", "dangling-source", "link"}, {"target", "dangling-target", "link"},
		{"subject", "dangling-subject", "comment"}, {"parent", "dangling-parent", "comment"}, {"base", "dangling-base", "entry"},
	} {
		rows, err := p.sql.QueryContext(ctx, `SELECT a.guid, a.file_path, a.`+q.col+` FROM artifacts a LEFT JOIN artifacts r ON r.guid = a.`+q.col+`
			WHERE a.kind = $1 AND a.`+q.col+` IS NOT NULL AND r.guid IS NULL`, q.kind)
		if err != nil {
			return nil, unavailable(err)
		}
		for rows.Next() {
			var g, path, ref string
			_ = rows.Scan(&g, &path, &ref)
			add("error", q.code, g, path, q.col+" "+ref+" does not exist")
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, unavailable(err)
		}
	}

	// overlay cycles
	rows, err = p.sql.QueryContext(ctx, `SELECT guid, base FROM artifacts WHERE base IS NOT NULL`)
	if err != nil {
		return nil, unavailable(err)
	}
	bases := map[string]string{}
	for rows.Next() {
		var g, b string
		_ = rows.Scan(&g, &b)
		bases[g] = b
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}
	reported := map[string]bool{}
	for g := range bases {
		seen := map[string]bool{}
		cur := g
		for cur != "" && !seen[cur] {
			seen[cur] = true
			cur = bases[cur]
		}
		if cur != "" && !reported[cur] {
			reported[cur] = true
			add("error", "overlay-cycle", cur, "", "overlay base chain is cyclic")
		}
	}

	// metadata locality (preferred invariant)
	scopes, err := p.Scopes(ctx)
	if err != nil {
		return nil, err
	}
	scopeSet := map[string]bool{}
	for _, s := range scopes {
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
	rows, err = p.sql.QueryContext(ctx, `SELECT m.guid, m.file_path, m.folder, s.folder FROM artifacts m JOIN artifacts s ON s.guid = COALESCE(m.source, m.subject)
		WHERE m.kind IN ('link','comment')`)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var g, path, folder, subjectFolder string
		_ = rows.Scan(&g, &path, &folder, &subjectFolder)
		if want := nearest(subjectFolder); want != folder {
			add("warning", "misplaced-metadata", g, path, "stored in scope \""+folder+"\" but its subject lives under scope \""+want+"\"")
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}

	// workflow consistency
	schemas, workflows, err := p.Config(ctx)
	if err != nil {
		return nil, err
	}
	rows, err = p.sql.QueryContext(ctx, `SELECT guid, file_path, type, folder, states FROM artifacts WHERE valid AND kind IN ('entry','document')`)
	if err != nil {
		return nil, unavailable(err)
	}
	for rows.Next() {
		var g, path, typ, folder, statesJSON string
		_ = rows.Scan(&g, &path, &typ, &folder, &statesJSON)
		eff := schemas.Effective(typ, folder)
		if eff == nil {
			add("warning", "unknown-type", g, path, "no schema defines type \""+typ+"\" at this location")
			continue
		}
		var states map[string]string
		_ = json.Unmarshal([]byte(statesJSON), &states)
		for _, wid := range eff.AllWorkflows() {
			wf := workflows.Resolve(wid, folder)
			if wf == nil {
				add("warning", "unknown-workflow", g, path, "schema assigns workflow \""+wid+"\" which is not defined here")
				continue
			}
			if st, ok := states[wid]; ok && !wf.HasState(st) {
				add("error", "unknown-state", g, path, "workflow \""+wid+"\" has no state \""+st+"\"")
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, unavailable(err)
	}

	sort.SliceStable(issues, func(i, j int) bool {
		if issues[i].Severity != issues[j].Severity {
			return issues[i].Severity < issues[j].Severity
		}
		return issues[i].Path < issues[j].Path
	})
	if issues == nil {
		issues = []Issue{}
	}
	return issues, nil
}
