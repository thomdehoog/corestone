package projection

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/testutil"
)

// testDB opens a projection on a fresh, isolated PostgreSQL schema so tests
// can run in parallel against one database. Requires CORESTONE_TEST_DSN.
func testDB(t *testing.T) (*DB, *gitx.Repo) {
	t.Helper()
	dsn := testutil.DSN(t)
	repo, err := gitx.Open(t.TempDir()+"/repo.git", "main")
	if err != nil {
		t.Fatal(err)
	}
	p, err := Open(context.Background(), dsn, repo)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.Close() })
	return p, repo
}

func commit(t *testing.T, repo *gitx.Repo, msg string, ops ...gitx.Op) string {
	t.Helper()
	ctx := context.Background()
	head, _ := repo.Head(ctx)
	c, err := repo.BuildCommit(ctx, head, msg, ops)
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Publish(ctx, head, c); err != nil {
		t.Fatal(err)
	}
	return c
}

func entryJSON(guid, typ, title, hid string, extra string) []byte {
	s := fmt.Sprintf(`{"guid":%q,"kind":"entry","type":%q,"title":%q`, guid, typ, title)
	if hid != "" {
		s += fmt.Sprintf(`,"hid":%q`, hid)
	}
	if extra != "" {
		s += "," + extra
	}
	return []byte(s + "}\n")
}

func TestSyncReplayAndRebuildAgree(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	g1, g2, l1, c1 := model.NewGUID(), model.NewGUID(), model.NewGUID(), model.NewGUID()

	commit(t, repo, "schema", gitx.Op{Path: ".corestone/schemas/req.json", Content: []byte(`{"type":"req","hid":{"prefix":"REQ"},"fields":[{"id":"prio","type":"text"}],"workflows":["dev"]}`)},
		gitx.Op{Path: ".corestone/workflows/dev.json", Content: []byte(`{"id":"dev","states":["open","done"],"transitions":[{"from":"open","to":"done"}]}`)},
		gitx.Op{Path: "README.md", Content: []byte("ignored")})
	commit(t, repo, "e1", gitx.Op{Path: "specs/a/" + g1 + "/.corestone.json", Content: entryJSON(g1, "req", "Boot fast", "REQ-1", `"fields":{"prio":"high","n":2},"workflows":{"dev":"open"}`)},
		gitx.Op{Path: "specs/a/" + g1 + "/notes.txt", Content: []byte("attachment")})
	commit(t, repo, "e2", gitx.Op{Path: "specs/b/" + g2 + "/.corestone.json", Content: entryJSON(g2, "req", "Show progress", "REQ-2", `"base":"`+g1+`"`)})
	commit(t, repo, "link+comment",
		gitx.Op{Path: "specs/.corestone/links/" + l1 + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"link","type":"refines","source":%q,"target":%q}`, l1, g2, g1))},
		gitx.Op{Path: "specs/.corestone/comments/" + c1 + ".json", Content: []byte(fmt.Sprintf(`{"guid":%q,"kind":"comment","type":"comment","subject":%q,"text":"why?","author":"a","created":"2026-01-01T00:00:00.000000000Z"}`, c1, g1))})

	if err := p.Sync(ctx); err != nil { // first sync = rebuild
		t.Fatal(err)
	}
	head, _ := repo.Head(ctx)
	if ph, _ := p.ProcessedHash(ctx); ph != head {
		t.Fatalf("processed %s head %s", ph, head)
	}
	snap1 := snapshot(t, p)

	// incremental: hid change + move + delete + attachment change
	commit(t, repo, "rename hid", gitx.Op{Path: "specs/a/" + g1 + "/.corestone.json", Content: entryJSON(g1, "req", "Boot fast", "REQ-100", `"fields":{"prio":"high"},"workflows":{"dev":"done"}`)})
	commit(t, repo, "move", gitx.Op{Path: "specs/b/" + g2 + "/.corestone.json", Delete: true},
		gitx.Op{Path: "archive/" + g2 + "/.corestone.json", Content: entryJSON(g2, "req", "Show progress", "REQ-2", `"base":"`+g1+`"`)})
	commit(t, repo, "delete comment", gitx.Op{Path: "specs/.corestone/comments/" + c1 + ".json", Delete: true},
		gitx.Op{Path: "specs/a/" + g1 + "/notes.txt", Delete: true})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	live := snapshot(t, p)
	if live == snap1 {
		t.Fatal("projection did not change")
	}
	// A full rebuild must reproduce the incrementally maintained state.
	if err := p.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	rebuilt := snapshot(t, p)
	if live != rebuilt {
		t.Fatalf("live projection differs from rebuild:\n--- live\n%s\n--- rebuilt\n%s", live, rebuilt)
	}

	loc, err := p.Locate(ctx, g2)
	if err != nil || loc.Folder != "archive" || loc.Kind != model.KindEntry {
		t.Fatalf("locate after move: %+v %v", loc, err)
	}
	if _, err := p.Locate(ctx, c1); !errors.Is(err, model.ErrNotFound) {
		t.Fatal("deleted comment still located")
	}
	del, _ := p.Deleted(ctx, "", 10)
	if len(del) != 1 || del[0].GUID != c1 || del[0].Kind != "comment" {
		t.Fatalf("deleted %+v", del)
	}
	hist, _ := p.HIDHistory(ctx, "", g1)
	if len(hist) != 2 {
		t.Fatalf("hid history %+v", hist)
	}
	var cur, old *HIDRecord
	for i := range hist {
		if hist[i].Current {
			cur = &hist[i]
		} else {
			old = &hist[i]
		}
	}
	if cur == nil || old == nil || cur.HID != "REQ-100" || old.HID != "REQ-1" || old.UntilCommit == "" || cur.SinceCommit == "" {
		t.Fatalf("hid history %+v", hist)
	}
	byHID, _ := p.HIDHistory(ctx, "REQ-1", "")
	if len(byHID) != 1 || byHID[0].GUID != g1 {
		t.Fatal("lookup by historical HID")
	}
	n, _ := p.NextHIDNumber(ctx, "REQ-")
	if n != 101 {
		t.Fatalf("next hid %d", n)
	}
	s, _ := p.Get(ctx, g1)
	if s.Workflows["dev"] != "done" || s.Links != 1 || s.Comments != 0 || s.CreatedAt == nil || s.ModifiedAt == nil || s.CreatedAt.After(*s.ModifiedAt) {
		t.Fatalf("summary %+v", s)
	}
	att, _ := p.Attachments(ctx, g1)
	if len(att) != 0 {
		t.Fatalf("attachment not removed: %+v", att)
	}
	in, out, _ := p.LinksOf(ctx, g1)
	if len(in) != 1 || len(out) != 0 || in[0].Source != g2 {
		t.Fatal("links")
	}
	folders, _ := p.Folders(ctx, "")
	if len(folders) != 2 || folders[0].Name != "archive" || folders[1].Name != "specs" || !folders[1].HasConfig || folders[1].Artifacts != 1 {
		t.Fatalf("folders %+v", folders)
	}
	// "specs" holds its one artifact in specs/a: nothing directly, one below
	if folders[1].Direct != 0 {
		t.Fatalf("direct count of specs: %+v", folders[1])
	}
	sub, _ := p.Folders(ctx, "specs")
	if len(sub) != 1 || sub[0].Path != "specs/a" || sub[0].Artifacts != 1 || sub[0].Direct != 1 {
		t.Fatalf("subfolders %+v", sub)
	}
	scope, _ := p.NearestScope(ctx, "specs/a/deep")
	if scope != "specs" {
		t.Fatalf("nearest scope %q", scope)
	}
	scope, _ = p.NearestScope(ctx, "archive")
	if scope != "" {
		t.Fatalf("nearest scope root %q", scope)
	}
	res, total, err := p.Search(ctx, Query{Text: "boot", Kinds: []model.Kind{model.KindEntry}, Subtree: true})
	if err != nil || total != 1 || res[0].GUID != g1 {
		t.Fatalf("search %v %d %v", res, total, err)
	}
	res, _, _ = p.Search(ctx, Query{Text: "REQ-2", Subtree: true})
	if len(res) != 1 || res[0].GUID != g2 {
		t.Fatal("search by hid")
	}
	res, _, _ = p.Search(ctx, Query{Fields: map[string]string{"prio": "high"}, Subtree: true})
	if len(res) != 1 {
		t.Fatal("field filter")
	}
	res, _, _ = p.Search(ctx, Query{States: map[string]string{"dev": "done"}, Folder: "specs", Subtree: true})
	if len(res) != 1 {
		t.Fatal("state filter")
	}
	res, _, _ = p.Search(ctx, Query{Folder: "specs", Subtree: false})
	if len(res) != 1 || res[0].Kind != model.KindLink { // only the link lives directly in specs
		t.Fatalf("exact folder %+v", res)
	}
	schemas, workflows, err := p.Config(ctx)
	if err != nil || schemas.Effective("req", "x") == nil || workflows.Resolve("dev", "x") == nil {
		t.Fatal("config indexes")
	}
	issues, err := p.Validate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, is := range issues {
		if is.Severity == "error" {
			t.Fatalf("unexpected issue %+v", is)
		}
	}
	st, _ := p.Stats(ctx)
	if st.Artifacts["entry"] != 2 || st.Artifacts["link"] != 1 || st.Deleted != 1 || st.Schemas != 1 {
		t.Fatalf("stats %+v", st)
	}
}

func TestHostileFilesNeverWedgeProjection(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	g := model.NewGUID()
	big := strings.Repeat("x", 600*1024)
	commit(t, repo, "hostile",
		gitx.Op{Path: "a/" + g + "/.corestone.json", Content: []byte(`{"guid":"` + g + `","kind":"entry","type":"t","title":"nul\u0000here","fields":{"big":"` + big + `","weird":"\u0000"}}`)},
		gitx.Op{Path: "a/" + model.NewGUID() + "/.corestone.json", Content: []byte(`not json at all`)},
		gitx.Op{Path: ".corestone/schemas/bad.json", Content: []byte(`{"type":"other"}`)},
		gitx.Op{Path: ".corestone/links/" + model.NewGUID() + ".json", Content: []byte(`{"guid":"nope"}`)},
	)
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	issues, err := p.Validate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	codes := map[string]int{}
	for _, i := range issues {
		codes[i.Code]++
	}
	if codes["invalid-artifact"] < 1 || codes["invalid-config"] != 1 {
		t.Fatalf("issues %+v", issues)
	}
	res, _, err := p.Search(ctx, Query{Text: "nul", Subtree: true})
	if err != nil || len(res) != 1 {
		t.Fatalf("search %v %v", res, err)
	}
	if err := p.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestForeignHistoryTriggersRebuild(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	g := model.NewGUID()
	c1 := commit(t, repo, "one", gitx.Op{Path: g + "/.corestone.json", Content: entryJSON(g, "t", "one", "", "")})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	// Rewrite history: a new root commit not descending from c1.
	c2, _ := repo.BuildCommit(ctx, "", "rewritten", []gitx.Op{{Path: g + "/.corestone.json", Content: entryJSON(g, "t", "rewritten", "", "")}})
	if err := repo.Publish(ctx, c1, c2); err != nil {
		t.Fatal(err)
	}
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	s, _ := p.Get(ctx, g)
	if s.Title != "rewritten" {
		t.Fatalf("title %q", s.Title)
	}
	if ph, _ := p.ProcessedHash(ctx); ph != c2 {
		t.Fatal("processed hash")
	}
	if st := p.Status(); st.Maintenance || !st.Capabilities.Search {
		t.Fatalf("status after rebuild %+v", st)
	}
}

// snapshot renders the projection tables deterministically for comparison.
func snapshot(t *testing.T, p *DB) string {
	t.Helper()
	var b strings.Builder
	dump := func(q string) {
		rows, err := p.sql.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			b.WriteString(line)
			b.WriteByte('\n')
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
	}
	dump(`SELECT concat_ws('|', guid, kind, type, title, hid, folder, path::text, file_path, blob_sha, base, source, target, subject, parent, author, created, states::text, fields::text, md5(search_text), valid, error, created_commit, modified_commit) FROM artifacts ORDER BY guid`)
	dump(`SELECT concat_ws('|', guid, field, value) FROM artifact_fields ORDER BY 1`)
	dump(`SELECT concat_ws('|', guid, name, path, blob_sha) FROM artifact_files ORDER BY 1`)
	dump(`SELECT concat_ws('|', path, scope, category, name, blob_sha, valid, error, data::text) FROM config_files ORDER BY 1`)
	dump(`SELECT concat_ws('|', guid, hid, since_commit, until_commit) FROM hid_history ORDER BY 1`)
	dump(`SELECT concat_ws('|', guid, kind, type, title, hid, last_path, deleted_commit) FROM deleted_artifacts ORDER BY 1`)
	dump(`SELECT concat_ws('|', path, guid, message) FROM file_issues ORDER BY 1`)
	return b.String()
}

// A request that gives up while the shared configuration is being loaded
// must not poison the cache for everyone else: the cache is filled without
// the caller's cancellation, and a truncated result is never cached.
func TestConfigCacheSurvivesCancelledRequest(t *testing.T) {
	p, repo := testDB(t)
	ctx := context.Background()
	commit(t, repo, "config",
		gitx.Op{Path: ".corestone/schemas/req.json", Content: []byte(`{"type":"req","hid":{"prefix":"R"}}`)},
		gitx.Op{Path: ".corestone/workflows/dev.json", Content: []byte(`{"id":"dev","initial":"open","states":["open"]}`)})
	if err := p.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if schemas, _, err := p.Config(cancelled); err != nil {
		t.Logf("cancelled config load: %v", err) // failing is fine; caching a truncated result is not
	} else if schemas.Effective("req", "") == nil {
		t.Fatal("cancelled config load returned an incomplete result")
	}
	schemas, workflows, err := p.Config(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if schemas.Effective("req", "") == nil {
		t.Fatal("schema missing after a cancelled request: the cache was poisoned")
	}
	if workflows == nil {
		t.Fatal("nil workflow index")
	}
}
