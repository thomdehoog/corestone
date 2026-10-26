package projection

import (
	"context"
	"database/sql"
	"strings"

	"github.com/lib/pq"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
)

// The artifact_commits table maps every artifact GUID to the commits that
// touched it, so an artifact's history is an index lookup instead of a
// pathspec scan over the whole repository history. seq orders the commits
// along the first-parent chain: a rebuild numbers the walked history 0, -1,
// -2, … from the head backwards; every replayed or written commit after
// that gets max(seq)+1.

// HistoryGUIDs returns the artifacts whose history a changed path belongs
// to: every GUID directory on the path (the artifact file, its attachments,
// nested artifacts) and the GUID of a link or comment file in .corestone.
func HistoryGUIDs(path string) []string {
	segs := strings.Split(path, "/")
	var out []string
	last := len(segs) - 1
	for _, s := range segs[:last] {
		if model.IsGUID(s) {
			out = append(out, s)
		}
	}
	if last >= 2 && segs[last-2] == ".corestone" && (segs[last-1] == "links" || segs[last-1] == "comments") {
		if g, ok := strings.CutSuffix(segs[last], ".json"); ok && model.IsGUID(g) {
			out = append(out, g)
		}
	}
	return out
}

func commitGUIDs(changes []gitx.Change) []string {
	seen := map[string]bool{}
	var out []string
	for _, ch := range changes {
		for _, g := range HistoryGUIDs(ch.Path) {
			if !seen[g] {
				seen[g] = true
				out = append(out, g)
			}
		}
	}
	return out
}

// recordCommit appends commit to the history of every artifact it touched.
func recordCommit(ctx context.Context, tx *sql.Tx, commit string, changes []gitx.Change) error {
	guids := commitGUIDs(changes)
	if len(guids) == 0 {
		return nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO artifact_commits (guid, commit_sha, seq)
		SELECT g, $2, (SELECT COALESCE(max(seq), 0) + 1 FROM artifact_commits) FROM unnest($1::text[]) AS g
		ON CONFLICT DO NOTHING`, pq.Array(guids), commit)
	return unavailable(err)
}

type commitRow struct {
	guid, commit string
	seq          int64
}

func (p *DB) insertCommitRows(ctx context.Context, rows []commitRow) error {
	if len(rows) == 0 {
		return nil
	}
	guids := make([]string, len(rows))
	commits := make([]string, len(rows))
	seqs := make([]int64, len(rows))
	for i, r := range rows {
		guids[i], commits[i], seqs[i] = r.guid, r.commit, r.seq
	}
	_, err := p.sql.ExecContext(ctx, `INSERT INTO artifact_commits (guid, commit_sha, seq)
		SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[]) ON CONFLICT DO NOTHING`,
		pq.Array(guids), pq.Array(commits), pq.Array(seqs))
	return unavailable(err)
}

// ArtifactCommits lists the commits that touched an artifact, newest first
// (all of them when limit <= 0).
func (p *DB) ArtifactCommits(ctx context.Context, guid string, limit int) ([]string, error) {
	var lim any
	if limit > 0 {
		lim = limit
	}
	rows, err := p.sql.QueryContext(ctx, `SELECT commit_sha FROM artifact_commits WHERE guid = $1
		ORDER BY seq DESC, commit_sha LIMIT $2`, guid, lim)
	if err != nil {
		return nil, unavailable(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, unavailable(err)
		}
		out = append(out, c)
	}
	return out, unavailable(rows.Err())
}
