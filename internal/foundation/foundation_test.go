package foundation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
	"github.com/thomdehoog/corestone/internal/testutil"
)

func open(t *testing.T) *Foundation {
	t.Helper()
	f, err := Open(context.Background(), t.TempDir()+"/repo.git", "main", testutil.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func obj(t *testing.T, s string) *ojson.Object {
	t.Helper()
	o, err := ojson.ParseObject([]byte(s))
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return o
}

func seed(t *testing.T, f *Foundation) {
	t.Helper()
	ctx := context.Background()
	must := func(_ any, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(f.PutWorkflow(ctx, "", "dev", []byte(`{"id":"dev","initial":"open","states":["open","review","done"],
		"transitions":[{"id":"submit","from":"open","to":"review"},{"from":"review","to":"done"},{"from":"review","to":"open"}]}`)))
	must(f.PutSchema(ctx, "", "requirement", []byte(`{"type":"requirement","displayName":"Requirement","hid":{"prefix":"REQ"},"workflows":["dev"],
		"fields":[{"id":"priority","name":"Priority","type":"enum","required":true,"options":[{"value":"low"},{"value":"medium"},{"value":"high"}]},
		          {"id":"rationale","type":"multiline"},{"id":"effort","type":"integer"},{"id":"owner","type":"reference"},{"id":"spec","type":"hyperlink"}]}`)))
	must(f.PutSchema(ctx, "", "testcase", []byte(`{"type":"testcase","hid":{"prefix":"TC","digits":3}}`)))
	must(f.PutSchema(ctx, "", "spec", []byte(`{"type":"spec","kind":"document","hid":{"prefix":"SPEC"}}`)))
	must(f.PutSchema(ctx, "", "verifies", []byte(`{"type":"verifies","kind":"link","sourceTypes":["testcase"],"targetTypes":["requirement"],"cardinality":"many-to-one",
		"fields":[{"id":"coverage","type":"enum","options":[{"value":"full"},{"value":"partial"}]}]}`)))
	must(f.PutSchema(ctx, "", "related", []byte(`{"type":"related","kind":"link"}`)))
}

func create(t *testing.T, f *Foundation, kind model.Kind, body string) *View {
	t.Helper()
	v, err := f.CreateArtifact(context.Background(), kind, obj(t, body))
	if err != nil {
		t.Fatalf("create %s: %v", body, err)
	}
	return v
}

func TestLifecycle(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)

	r1 := create(t, f, model.KindEntry, `{"path":"specs/boot","type":"requirement","title":"Boot fast","fields":{"priority":"high","rationale":"latency sells","effort":3}}`)
	if r1.Meta.HID != "REQ-1" || r1.Meta.Workflows["dev"] != "open" || r1.ETag == "" {
		t.Fatalf("created %+v", r1.Meta)
	}
	r2 := create(t, f, model.KindEntry, `{"path":"specs/boot","type":"requirement","title":"Show progress","fields":{"priority":"low"}}`)
	if r2.Meta.HID != "REQ-2" {
		t.Fatalf("hid %s", r2.Meta.HID)
	}
	tc := create(t, f, model.KindEntry, `{"path":"tests","type":"testcase","title":"Cold boot"}`)
	if tc.Meta.HID != "TC-001" {
		t.Fatalf("padded hid %s", tc.Meta.HID)
	}
	// validation
	for _, bad := range []string{
		`{"path":"specs","type":"requirement","title":"no prio"}`,                                     // required field
		`{"path":"specs","type":"requirement","title":"x","fields":{"priority":"urgent"}}`,            // enum value
		`{"path":"specs","type":"requirement","title":"x","fields":{"priority":"low","effort":"3"}}`,  // integer type
		`{"path":"specs","type":"requirement","title":"x","hid":"REQ-1","fields":{"priority":"low"}}`, // duplicate hid
		`{"path":"../x","type":"requirement","title":"x","fields":{"priority":"low"}}`,                // folder
		`{"path":"specs","type":"requirement","title":"","fields":{"priority":"low"}}`,                // title
		`{"path":"specs","type":"requirement","title":"x","base":"` + model.NewGUID() + `","fields":{"priority":"low"}}`,
		`{"path":"specs","type":"requirement","title":"x","fields":{"priority":"low","owner":"` + model.NewGUID() + `"}}`, // dangling reference
		`{"path":"specs","type":"verifies","title":"x"}`,                                                                  // link type as entry
	} {
		_, err := f.CreateArtifact(ctx, model.KindEntry, obj(t, bad))
		if err == nil {
			t.Errorf("accepted %s", bad)
		} else if !errors.Is(err, model.ErrValidation) && !errors.Is(err, model.ErrConflict) {
			t.Errorf("%s: unexpected error class %v", bad, err)
		}
	}
	// update with ETag
	upd, err := f.UpdateArtifact(ctx, r1.Meta.GUID, r1.ETag, obj(t, `{"title":"Boot in under 2 s","fields":{"effort":5,"rationale":null}}`))
	if err != nil {
		t.Fatal(err)
	}
	if upd.Meta.Title != "Boot in under 2 s" || upd.Data.Object("fields").String("rationale") != "" || upd.Data.Object("fields").Len() != 2 {
		t.Fatalf("update result %s", ojson.MustEncode(upd.Data, ojson.Style{}))
	}
	if _, err := f.UpdateArtifact(ctx, r1.Meta.GUID, r1.ETag, obj(t, `{"title":"stale"}`)); !errors.Is(err, model.ErrPrecondition) {
		t.Fatalf("stale etag: %v", err)
	}
	if _, err := f.UpdateArtifact(ctx, r1.Meta.GUID, "", obj(t, `{"hid":"REQ-2"}`)); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("duplicate hid on update: %v", err)
	}
	if _, err := f.UpdateArtifact(ctx, r1.Meta.GUID, "", obj(t, `{"workflows":{"dev":"done"}}`)); !errors.Is(err, model.ErrValidation) {
		t.Fatal("workflow bypass accepted")
	}
	// no-op update creates no commit
	before, _ := f.Repo.Head(ctx)
	same, err := f.UpdateArtifact(ctx, r1.Meta.GUID, "", obj(t, `{"title":"Boot in under 2 s"}`))
	if err != nil || same.ETag != upd.ETag {
		t.Fatalf("noop %v", err)
	}
	if after, _ := f.Repo.Head(ctx); after != before {
		t.Fatal("no-op update created a commit")
	}
	// HID rename and lookup history
	ren, err := f.UpdateArtifact(ctx, r1.Meta.GUID, "", obj(t, `{"hid":"REQ-1000"}`))
	if err != nil || ren.Meta.HID != "REQ-1000" {
		t.Fatal(err)
	}
	hist, _ := f.HIDLookup(ctx, "REQ-1")
	if len(hist) != 1 || hist[0].GUID != r1.Meta.GUID || hist[0].Current {
		t.Fatalf("hid lookup %+v", hist)
	}
	r3 := create(t, f, model.KindEntry, `{"path":"specs","type":"requirement","title":"next","fields":{"priority":"low"}}`)
	if r3.Meta.HID != "REQ-1001" {
		t.Fatalf("generated hid must skip history: %s", r3.Meta.HID)
	}

	// overlay
	ov := create(t, f, model.KindEntry, `{"path":"specs/boot/variants","type":"requirement","title":"Embedded variant","base":"`+r1.Meta.GUID+`","fields":{"priority":"medium"}}`)
	res, err := f.Overlay(ctx, ov.Meta.GUID)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Chain) != 2 || res.Fields.String("priority") != "medium" || res.Origin["effort"] != r1.Meta.GUID {
		t.Fatalf("overlay %+v", res)
	}
	base, _ := f.Overlay(ctx, r1.Meta.GUID)
	if len(base.Overlays) != 1 || base.Overlays[0].GUID != ov.Meta.GUID {
		t.Fatal("reverse overlay listing")
	}
	if _, err := f.UpdateArtifact(ctx, r1.Meta.GUID, "", obj(t, `{"base":"`+ov.Meta.GUID+`"}`)); !errors.Is(err, model.ErrValidation) {
		t.Fatalf("overlay cycle accepted: %v", err)
	}
	// overlay may omit required fields that the base provides
	if _, err := f.CreateArtifact(ctx, model.KindEntry, obj(t, `{"path":"specs","type":"requirement","title":"thin overlay","base":"`+r1.Meta.GUID+`"}`)); err != nil {
		t.Fatalf("thin overlay: %v", err)
	}

	// links: endpoint rules, cardinality, duplicates
	if _, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+r1.Meta.GUID+`","target":"`+tc.Meta.GUID+`"}`)); !errors.Is(err, model.ErrValidation) {
		t.Fatalf("wrong direction accepted: %v", err)
	}
	l1, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r1.Meta.GUID+`","fields":{"coverage":"full"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if l1.Meta.Folder != "" || !strings.HasPrefix(l1.Meta.Path, ".corestone/links/") {
		t.Fatalf("link stored at %s", l1.Meta.Path)
	}
	if _, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r1.Meta.GUID+`"}`)); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("duplicate link: %v", err)
	}
	if _, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r2.Meta.GUID+`"}`)); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("many-to-one violated: %v", err)
	}
	if _, err := f.CreateLink(ctx, obj(t, `{"type":"verifies","source":"`+tc.Meta.GUID+`","target":"`+r1.Meta.GUID+`","fields":{"coverage":"none"}}`)); err == nil {
		t.Fatal("link field validation")
	}
	if _, err := f.CreateLink(ctx, obj(t, `{"type":"related","source":"`+r1.Meta.GUID+`","target":"`+r2.Meta.GUID+`"}`)); err != nil {
		t.Fatal(err)
	}
	rel, err := f.Relationships(ctx, r1.Meta.GUID)
	if err != nil || len(rel.Incoming) != 1 || len(rel.Outgoing) != 1 || rel.Incoming[0].Other.HID != "TC-001" {
		t.Fatalf("relationships %+v %v", rel, err)
	}
	if len(rel.AsTarget) != 2 || len(rel.AsSource) != 1 { // verifies+related as target, related as source
		t.Fatalf("allowed link types %d %d", len(rel.AsSource), len(rel.AsTarget))
	}

	// comments and threads
	c1, err := f.CreateComment(ctx, obj(t, `{"subject":"`+r1.Meta.GUID+`","text":"Is 2 s realistic?","author":"alice"}`))
	if err != nil {
		t.Fatal(err)
	}
	c2, err := f.CreateComment(ctx, obj(t, `{"subject":"`+r1.Meta.GUID+`","parent":"`+c1.Meta.GUID+`","text":"On the fast SKU yes."}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.CreateComment(ctx, obj(t, `{"subject":"`+r2.Meta.GUID+`","parent":"`+c1.Meta.GUID+`","text":"wrong thread"}`)); !errors.Is(err, model.ErrValidation) {
		t.Fatal("cross-subject parent accepted")
	}
	comments, _ := f.Comments(ctx, r1.Meta.GUID)
	if len(comments) != 2 || comments[0].Meta.GUID != c1.Meta.GUID || comments[1].Data.String("parent") != c1.Meta.GUID || comments[1].Data.String("text") == "" {
		t.Fatalf("comments %+v", comments)
	}
	_ = c2

	// workflow evaluation and transitions
	ws, _ := f.Workflows(ctx, r1.Meta.GUID)
	if len(ws) != 1 || ws[0].State != "open" || len(ws[0].Available) != 1 || ws[0].Available[0].ID != "submit" {
		t.Fatalf("workflows %+v", ws)
	}
	if _, err := f.Transition(ctx, r1.Meta.GUID, "dev", "done", ""); !errors.Is(err, model.ErrValidation) {
		t.Fatal("illegal transition accepted")
	}
	tr, err := f.Transition(ctx, r1.Meta.GUID, "dev", "submit", "")
	if err != nil || tr.Meta.Workflows["dev"] != "review" {
		t.Fatalf("transition by id: %v %+v", err, tr.Meta)
	}
	if _, err := f.Transition(ctx, r1.Meta.GUID, "publish", "x", ""); !errors.Is(err, model.ErrValidation) {
		t.Fatal("unassigned workflow accepted")
	}

	// attachments
	if err := f.PutAttachment(ctx, r1.Meta.GUID, "notes.txt", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := f.PutAttachment(ctx, r1.Meta.GUID, ".corestone.json", []byte("x")); err == nil {
		t.Fatal("reserved attachment name accepted")
	}
	got, _, err := f.Attachment(ctx, r1.Meta.GUID, "notes.txt")
	if err != nil || string(got) != "hello" {
		t.Fatal("attachment read")
	}

	// move: identity, metadata locality and attachments follow
	if _, err := f.PutSchema(ctx, "archive", "requirement", []byte(`{"type":"requirement","fields":[{"id":"reason","type":"text"}]}`)); err != nil {
		t.Fatal(err)
	}
	mv, err := f.MoveArtifact(ctx, r1.Meta.GUID, "archive/2026")
	if err != nil {
		t.Fatal(err)
	}
	if mv.Meta.Folder != "archive/2026" || mv.Meta.HID != "REQ-1000" {
		t.Fatalf("moved %+v", mv.Meta)
	}
	v, err := f.Get(ctx, r1.Meta.GUID)
	if err != nil || v.Meta.Folder != "archive/2026" || len(v.Attachments) != 1 || v.Meta.Workflows["dev"] != "review" {
		t.Fatalf("after move %+v %v", v, err)
	}
	comments, _ = f.Comments(ctx, r1.Meta.GUID)
	if len(comments) != 2 || comments[0].Meta.Folder != "archive" {
		t.Fatalf("comments did not follow to the nearest scope: %+v", comments[0].Meta)
	}
	eff, loc, _ := f.SchemaOf(ctx, r1.Meta.GUID)
	if loc.Folder != "archive/2026" || eff.Field("reason") == nil || eff.Field("priority") == nil {
		t.Fatal("effective schema at new location")
	}
	hist, _ = f.HIDLookup(ctx, "REQ-1000")
	if len(hist) != 1 || !hist[0].Current {
		t.Fatal("hid after move")
	}
	log, _ := f.History(ctx, r1.Meta.GUID, 0)
	if len(log) < 5 || !strings.Contains(log[0].Subject, "moved") || log[len(log)-1].Trailers["Corestone-Op"] != "create" {
		t.Fatalf("history %+v", log)
	}

	// folder move (rename) keeps everything
	n, err := f.MoveFolder(ctx, "specs/boot", "specs/startup")
	if err != nil || n < 2 {
		t.Fatalf("folder move %d %v", n, err)
	}
	v2, _ := f.Get(ctx, r2.Meta.GUID)
	if v2.Meta.Folder != "specs/startup" {
		t.Fatalf("r2 folder %s", v2.Meta.Folder)
	}
	vo, _ := f.Get(ctx, ov.Meta.GUID)
	if vo.Meta.Folder != "specs/startup/variants" {
		t.Fatalf("overlay folder %s", vo.Meta.Folder)
	}
	if _, err := f.MoveFolder(ctx, "specs", "specs/inner"); !errors.Is(err, model.ErrValidation) {
		t.Fatal("move into itself accepted")
	}
	if _, err := f.MoveFolder(ctx, "nope", "x"); !errors.Is(err, model.ErrNotFound) {
		t.Fatal("moving a missing folder")
	}

	// delete cascades links, comments, replies and attachments
	if err := f.DeleteArtifact(ctx, r1.Meta.GUID, "wrong"); !errors.Is(err, model.ErrPrecondition) {
		t.Fatal("delete precondition")
	}
	if err := f.DeleteArtifact(ctx, r1.Meta.GUID, ""); err != nil {
		t.Fatal(err)
	}
	for _, g := range []string{r1.Meta.GUID, l1.Meta.GUID, c1.Meta.GUID, c2.Meta.GUID} {
		if _, err := f.Get(ctx, g); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("%s survived cascade: %v", g, err)
		}
	}
	del, _ := f.DB.Deleted(ctx, "", 10)
	if len(del) != 5 { // r1, both links, both comments
		t.Fatalf("deleted %d", len(del))
	}
	head, _ := f.Repo.Head(ctx)
	entries, _ := f.Repo.ListTree(ctx, head)
	for _, e := range entries {
		if strings.Contains(e.Path, r1.Meta.GUID) {
			t.Fatalf("file survived delete: %s", e.Path)
		}
	}
	// overlay base is now dangling: validation reports it, overlay resolution fails cleanly
	issues, _ := f.DB.Validate(ctx)
	found := false
	for _, is := range issues {
		if is.Code == "dangling-base" {
			found = true
		}
	}
	if !found {
		t.Fatalf("validation missed dangling base: %+v", issues)
	}
	if _, err := f.Overlay(ctx, ov.Meta.GUID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("dangling overlay: %v", err)
	}

	// The live projection equals a rebuild after all of this.
	live := dump(t, f.DB)
	if err := f.DB.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	if rebuilt := dump(t, f.DB); rebuilt != live {
		t.Fatalf("rebuild differs\n--- live\n%s--- rebuilt\n%s", live, rebuilt)
	}
	st, _ := f.Status(ctx)
	if !st.InSync || st.Stats.Artifacts["entry"] == 0 {
		t.Fatalf("status %+v", st)
	}
}

func TestFormatFidelityAndDirectPush(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	g := model.NewGUID()
	// A hand-written file: tabs, CRLF, no trailing newline, custom property.
	raw := "{\r\n\t\"guid\": \"" + g + "\",\r\n\t\"kind\": \"entry\",\r\n\t\"type\": \"requirement\",\r\n\t\"x-tool\": {\"keep\": [1, 2]},\r\n\t\"title\": \"Hand made\",\r\n\t\"fields\": {\r\n\t\t\"priority\": \"low\"\r\n\t}\r\n}"
	head, _ := f.Repo.Head(ctx)
	c, err := f.Repo.BuildCommit(ctx, head, "external push", []gitx.Op{{Path: "ext/" + g + "/.corestone.json", Content: []byte(raw)}})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Repo.Publish(ctx, head, c); err != nil {
		t.Fatal(err)
	}
	// Reads resynchronize automatically.
	v, err := f.Get(ctx, g)
	if err != nil || v.Meta.Title != "Hand made" {
		t.Fatalf("get after push: %v", err)
	}
	// A title edit keeps everything else byte for byte.
	upd, err := f.UpdateArtifact(ctx, g, "", obj(t, `{"title":"Hand made (edited)"}`))
	if err != nil {
		t.Fatal(err)
	}
	stored, _, _ := f.Repo.ReadPath(ctx, mustHead(t, f), upd.Meta.Path)
	want := strings.Replace(raw, "Hand made", "Hand made (edited)", 1)
	// the update also initializes the workflow state (appended property)
	want = strings.TrimSuffix(want, "\r\n}") + ",\r\n\t\"workflows\": {\r\n\t\t\"dev\": \"open\"\r\n\t}\r\n}"
	if !bytes.Equal(stored, []byte(want)) {
		t.Fatalf("format not preserved:\n%q\n%q", stored, want)
	}
	if !strings.Contains(string(stored), `"x-tool": {`) {
		t.Fatal("unknown property lost")
	}
}

func mustHead(t *testing.T, f *Foundation) string {
	h, err := f.Repo.Head(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestConcurrentWritersAndSecondProcess(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	// A second Foundation on the same repository and database = second server process.
	g, err := Open(ctx, f.Repo.Dir, "main", dsnOf(t, f))
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()

	const n = 24
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			fd := f
			if i%2 == 1 {
				fd = g
			}
			_, err := fd.CreateArtifact(ctx, model.KindEntry, obj(t, fmt.Sprintf(`{"path":"specs/%d","type":"requirement","title":"R%d","fields":{"priority":"low"}}`, i%3, i)))
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, fd := range []*Foundation{f, g} {
		if err := fd.DB.Sync(ctx); err != nil {
			t.Fatal(err)
		}
		res, total, err := fd.Search(ctx, projection.Query{Kinds: []model.Kind{model.KindEntry}, Subtree: true, Limit: 100})
		if err != nil || total != n {
			t.Fatalf("total %d err %v", total, err)
		}
		seen := map[string]bool{}
		for _, r := range res {
			if seen[r.HID] {
				t.Fatalf("duplicate HID %s under concurrency", r.HID)
			}
			seen[r.HID] = true
		}
		live := dump(t, fd.DB)
		if err := fd.DB.Reindex(ctx); err != nil {
			t.Fatal(err)
		}
		if dump(t, fd.DB) != live {
			t.Fatal("live projection differs from rebuild after concurrent writes")
		}
	}
	log, _ := f.Repo.Log(ctx, mustHead(t, f), nil, 0)
	if len(log) != n+6 { // 6 seed commits
		t.Fatalf("commits %d", len(log))
	}
}

func dsnOf(t *testing.T, f *Foundation) string {
	t.Helper()
	var sp string
	if err := f.DB.SQL().QueryRow(`SHOW search_path`).Scan(&sp); err != nil {
		t.Fatal(err)
	}
	base := strings.TrimSpace(strings.Split(sp, ",")[0])
	dsn := testutilBase(t)
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + "search_path=" + base + ",public"
}

func testutilBase(t *testing.T) string {
	dsn := envDSN()
	if dsn == "" {
		t.Skip("CORESTONE_TEST_DSN not set")
	}
	return dsn
}

func dump(t *testing.T, p *projection.DB) string {
	t.Helper()
	var b strings.Builder
	for _, q := range []string{
		`SELECT concat_ws('|', guid, kind, type, title, hid, folder, file_path, blob_sha, base, source, target, subject, parent, states::text, fields::text, md5(search_text), valid, created_commit, modified_commit) FROM artifacts ORDER BY guid`,
		`SELECT concat_ws('|', guid, field, value) FROM artifact_fields ORDER BY 1`,
		`SELECT concat_ws('|', guid, name, path, blob_sha) FROM artifact_files ORDER BY 1`,
		`SELECT concat_ws('|', path, scope, category, name, blob_sha, valid) FROM config_files ORDER BY 1`,
		`SELECT concat_ws('|', guid, hid, since_commit, until_commit) FROM hid_history ORDER BY 1`,
		`SELECT concat_ws('|', guid, kind, title, hid, last_path, deleted_commit) FROM deleted_artifacts ORDER BY 1`,
		`SELECT concat_ws('|', path, guid, message) FROM file_issues ORDER BY 1`,
	} {
		rows, err := p.SQL().Query(q)
		if err != nil {
			t.Fatal(err)
		}
		for rows.Next() {
			var s string
			_ = rows.Scan(&s)
			b.WriteString(s + "\n")
		}
		rows.Close()
	}
	return b.String()
}
