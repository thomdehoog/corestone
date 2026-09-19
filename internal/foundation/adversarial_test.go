package foundation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/projection"
)

// Adversarial suite: hostile inputs, races between validations, and
// direct Git pushes that break the preferred repository organization.

func TestHostileInputsAreRejectedCleanly(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	deep := strings.Repeat("[", 20000) + strings.Repeat("]", 20000)
	cases := []string{
		`{"path":"a/../b","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":"a/.corestone","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":"` + model.NewGUID() + `","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":":!magic","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":"a\u0000b","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":"a\nb","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":"` + strings.Repeat("x/", 40) + `","type":"requirement","title":"x","fields":{"priority":"low"}}`,
		`{"path":"a","type":"../../etc","title":"x"}`,
		`{"path":"a","type":"req uirement","title":"x"}`,
		`{"path":"a","type":"requirement","title":"` + strings.Repeat("t", 5000) + `","fields":{"priority":"low"}}`,
		`{"path":"a","type":"requirement","title":"nul\u0000","fields":{"priority":"low"}}`,
		`{"path":"a","type":"requirement","title":"x","hid":"REQ 1","fields":{"priority":"low"}}`,
		`{"path":"a","type":"requirement","title":"x","hid":"` + strings.Repeat("H", 100) + `","fields":{"priority":"low"}}`,
		`{"path":"a","type":"requirement","title":"x","fields":{"priority":"low","spec":"javascript:alert(1)"}}`,
		`{"path":"a","type":"requirement","title":"x","fields":{"priority":"low","spec":"data:text/html,hi"}}`,
		`{"path":"a","type":"requirement","title":"x","fields":{"priority":"low","owner":"not-a-guid"}}`,
		`{"path":"a","type":"requirement","title":"x","fields":{"priority":"low","effort":9007199254740993.5}}`,
		`{"path":"a","type":"requirement","title":"x","fields":{"priority":["low"]}}`,
		`{"path":"a","type":"requirement","title":"x","fields":` + deep + `}`,
		`{"path":"a","type":"requirement","title":"x","base":"` + strings.ToUpper(model.NewGUID()) + `x","fields":{"priority":"low"}}`,
	}
	for _, c := range cases {
		o, err := parse(c)
		if err != nil {
			continue // unparsable requests are rejected at the HTTP layer
		}
		_, err = f.CreateArtifact(ctx, model.KindEntry, o)
		if err == nil {
			t.Errorf("accepted %.120s", c)
			continue
		}
		if !errors.Is(err, model.ErrValidation) && !errors.Is(err, model.ErrConflict) && !errors.Is(err, model.ErrNotFound) {
			t.Errorf("%.80s: wrong error class: %v", c, err)
		}
	}
	// Nothing hostile reached the repository.
	head, _ := f.Repo.Head(ctx)
	log, _ := f.Repo.Log(ctx, head, nil, 0)
	if len(log) != 6 {
		t.Fatalf("hostile requests produced commits: %d", len(log))
	}
	// Attachment names cannot escape the GUID directory.
	r := create(t, f, model.KindEntry, `{"path":"a","type":"requirement","title":"ok","fields":{"priority":"low"}}`)
	for _, name := range []string{"../x", "..", "a/b", `a\b`, ".corestone.json", ".corestone", "", strings.Repeat("n", 300), "x\x00y", ":x"} {
		if err := f.PutAttachment(ctx, r.Meta.GUID, name, []byte("x")); err == nil {
			t.Errorf("attachment name %q accepted", name)
		}
	}
	// Unicode and awkward-but-legal names work end to end.
	u := create(t, f, model.KindEntry, `{"path":"spécs/日本語/a.b c'd\"e","type":"requirement","title":"ünïcode <b>&amp;</b>","fields":{"priority":"low"}}`)
	got, err := f.Get(ctx, u.Meta.GUID)
	if err != nil || got.Meta.Folder != "spécs/日本語/a.b c'd\"e" || got.Meta.Title != "ünïcode <b>&amp;</b>" {
		t.Fatalf("unicode round trip: %+v %v", got, err)
	}
	res, _, _ := f.Search(ctx, projection.Query{Folder: "spécs/日本語", Subtree: true})
	if len(res) != 1 {
		t.Fatal("unicode folder subtree query")
	}
	tree, _ := f.Tree(ctx, "spécs", false, 10, 0)
	if len(tree.Folders) != 1 || tree.Folders[0].Name != "日本語" {
		t.Fatalf("unicode tree %+v", tree.Folders)
	}
	if err := f.PutAttachment(ctx, u.Meta.GUID, "ré sumé.pdf", []byte("%PDF")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.MoveArtifact(ctx, u.Meta.GUID, "spécs/ärchive"); err != nil {
		t.Fatal(err)
	}
	if b, _, err := f.Attachment(ctx, u.Meta.GUID, "ré sumé.pdf"); err != nil || string(b) != "%PDF" {
		t.Fatalf("attachment after unicode move: %v", err)
	}
}

func parse(s string) (o *ojsonObject, err error) {
	return parseObject(s)
}

// TestValidationRaces checks that invariants validated against one head
// still hold when two writers race: overlay cycles, one-to-one links,
// duplicate HIDs and stale ETags.
func TestValidationRaces(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	if _, err := f.PutSchema(ctx, "", "spouse", []byte(`{"type":"spouse","kind":"link","cardinality":"one-to-one"}`)); err != nil {
		t.Fatal(err)
	}
	a := create(t, f, model.KindEntry, `{"path":"r","type":"requirement","title":"A","fields":{"priority":"low"}}`)
	b := create(t, f, model.KindEntry, `{"path":"r","type":"requirement","title":"B","fields":{"priority":"low"}}`)
	c := create(t, f, model.KindEntry, `{"path":"r","type":"requirement","title":"C","fields":{"priority":"low"}}`)

	race := func(name string, ops ...func() error) []error {
		t.Helper()
		var wg sync.WaitGroup
		errs := make([]error, len(ops))
		for i, op := range ops {
			wg.Add(1)
			go func(i int, op func() error) { defer wg.Done(); errs[i] = op() }(i, op)
		}
		wg.Wait()
		return errs
	}
	count := func(errs []error) (ok, bad int) {
		for _, e := range errs {
			if e == nil {
				ok++
			} else {
				bad++
			}
		}
		return
	}

	// Overlay cycle: A.base = B and B.base = A concurrently → at most one succeeds.
	errs := race("cycle",
		func() error {
			_, err := f.UpdateArtifact(ctx, a.Meta.GUID, "", must(parse(`{"base":"`+b.Meta.GUID+`"}`)))
			return err
		},
		func() error {
			_, err := f.UpdateArtifact(ctx, b.Meta.GUID, "", must(parse(`{"base":"`+a.Meta.GUID+`"}`)))
			return err
		})
	if ok, _ := count(errs); ok != 1 {
		t.Fatalf("overlay cycle race: %v", errs)
	}
	if _, err := f.Overlay(ctx, a.Meta.GUID); err != nil {
		t.Fatalf("repository has a cycle: %v", err)
	}

	// One-to-one link: two links from the same source concurrently → one.
	errs = race("one-to-one",
		func() error {
			_, err := f.CreateLink(ctx, must(parse(`{"type":"spouse","source":"`+a.Meta.GUID+`","target":"`+b.Meta.GUID+`"}`)))
			return err
		},
		func() error {
			_, err := f.CreateLink(ctx, must(parse(`{"type":"spouse","source":"`+a.Meta.GUID+`","target":"`+c.Meta.GUID+`"}`)))
			return err
		})
	if ok, _ := count(errs); ok != 1 {
		t.Fatalf("cardinality race: %v", errs)
	}
	if n, _ := f.DB.CountLinks(ctx, "spouse", a.Meta.GUID, ""); n != 1 {
		t.Fatalf("cardinality violated: %d links", n)
	}

	// Duplicate HID: same explicit HID from two writers → one.
	errs = race("hid",
		func() error {
			_, err := f.CreateArtifact(ctx, model.KindEntry, must(parse(`{"path":"r","type":"requirement","title":"H1","hid":"RACE-1","fields":{"priority":"low"}}`)))
			return err
		},
		func() error {
			_, err := f.CreateArtifact(ctx, model.KindEntry, must(parse(`{"path":"r","type":"requirement","title":"H2","hid":"RACE-1","fields":{"priority":"low"}}`)))
			return err
		})
	if ok, _ := count(errs); ok != 1 {
		t.Fatalf("hid race: %v", errs)
	}
	res, _, _ := f.Search(ctx, projection.Query{HID: "RACE-1", Subtree: true})
	if len(res) != 1 {
		t.Fatalf("duplicate HID in projection: %d", len(res))
	}

	// Same ETag from two clients → exactly one 200, one 412.
	cur, _ := f.Get(ctx, c.Meta.GUID)
	errs = race("etag",
		func() error {
			_, err := f.UpdateArtifact(ctx, c.Meta.GUID, cur.ETag, must(parse(`{"title":"first"}`)))
			return err
		},
		func() error {
			_, err := f.UpdateArtifact(ctx, c.Meta.GUID, cur.ETag, must(parse(`{"title":"second"}`)))
			return err
		})
	ok, _ := count(errs)
	pre := 0
	for _, e := range errs {
		if errors.Is(e, model.ErrPrecondition) {
			pre++
		}
	}
	if ok != 1 || pre != 1 {
		t.Fatalf("etag race: %v", errs)
	}

	// Concurrent transitions with the same precondition: one wins.
	cur, _ = f.Get(ctx, c.Meta.GUID)
	errs = race("transition",
		func() error { _, err := f.Transition(ctx, c.Meta.GUID, "dev", "submit", cur.ETag); return err },
		func() error { _, err := f.Transition(ctx, c.Meta.GUID, "dev", "submit", cur.ETag); return err })
	if ok, _ := count(errs); ok != 1 {
		t.Fatalf("transition race: %v", errs)
	}

	// Everything above must be reproducible from Git.
	live := dump(t, f.DB)
	if err := f.DB.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	if dump(t, f.DB) != live {
		t.Fatal("projection diverged from rebuild after races")
	}
}

// TestHostileRepositoryContent pushes malformed and conflicting files
// directly into Git: the projection must stay rebuildable, reads must not
// fabricate, and the validation service must report every problem.
func TestHostileRepositoryContent(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	ok := create(t, f, model.KindEntry, `{"path":"good","type":"requirement","title":"Good","fields":{"priority":"low"}}`)
	g2, g3 := model.NewGUID(), model.NewGUID()
	head := mustHead(t, f)
	c, err := f.Repo.BuildCommit(ctx, head, "hostile push", []gitx.Op{
		{Path: "bad/" + g2 + "/.corestone.json", Content: []byte("{not json")},
		{Path: "bad/" + g3 + "/.corestone.json", Content: []byte(`{"guid":"` + ok.Meta.GUID + `","kind":"entry","type":"requirement","title":"GUID thief"}`)}, // claims an existing GUID
		{Path: "bad/" + model.NewGUID() + "/.corestone.json", Content: []byte(`{"guid":"` + model.NewGUID() + `","kind":"link","type":"x","source":"` + ok.Meta.GUID + `","target":"` + ok.Meta.GUID + `"}`)},
		{Path: "bad/.corestone/links/not-a-guid.json", Content: []byte(`{"guid":"` + model.NewGUID() + `","kind":"link","type":"related","source":"` + ok.Meta.GUID + `","target":"` + model.NewGUID() + `"}`)},
		{Path: "bad/.corestone/comments/" + model.NewGUID() + ".json", Content: []byte(`{"guid":"` + model.NewGUID() + `","kind":"comment","subject":"` + model.NewGUID() + `","text":"orphan"}`)},
		{Path: "bad/.corestone/schemas/requirement.json", Content: []byte(`{"type":"other"}`)},
		{Path: "bad/.corestone/workflows/dev.json", Content: []byte(`{"id":"dev","states":[]}`)},
		{Path: ".corestone/scanner.json", Content: []byte(`{"guid_files":["a/b"]}`)},
		{Path: "huge/" + model.NewGUID() + "/.corestone.json", Content: []byte(`{"guid":"` + model.NewGUID() + `","kind":"entry","type":"t","title":"` + strings.Repeat("x", 2<<20) + `"}`)},
		{Path: "bin/" + model.NewGUID() + "/.corestone.json", Content: []byte("\x00\x01\x02\xff\xfe")},
		{Path: "cycle/" + model.NewGUID() + "/.corestone.json", Content: []byte(`{"guid":"11111111-1111-4111-8111-111111111111","kind":"entry","type":"requirement","title":"c1","base":"22222222-2222-4222-8222-222222222222"}`)},
		{Path: "cycle/" + model.NewGUID() + "/.corestone.json", Content: []byte(`{"guid":"22222222-2222-4222-8222-222222222222","kind":"entry","type":"requirement","title":"c2","base":"11111111-1111-4111-8111-111111111111"}`)},
		{Path: "dup/" + model.NewGUID() + "/.corestone.json", Content: []byte(`{"guid":"33333333-3333-4333-8333-333333333333","kind":"entry","type":"requirement","title":"dup a","hid":"REQ-1"}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Repo.Publish(ctx, head, c); err != nil {
		t.Fatal(err)
	}
	// Reads resynchronize and keep serving.
	v, err := f.Get(ctx, ok.Meta.GUID)
	if err != nil || v.Meta.Title != "Good" || v.Meta.Folder != "good" {
		t.Fatalf("the GUID thief displaced the real artifact: %+v %v", v, err)
	}
	issues, err := f.DB.Validate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	codes := map[string]int{}
	for _, i := range issues {
		codes[i.Code]++
	}
	for _, want := range []string{"invalid-artifact", "invalid-config", "dangling-target", "dangling-subject", "overlay-cycle", "duplicate-hid", "duplicate-guid"} {
		if codes[want] == 0 {
			t.Errorf("validation missed %s: %+v", want, codes)
		}
	}
	// Writes still work, and the live projection equals a rebuild.
	create(t, f, model.KindEntry, `{"path":"good","type":"requirement","title":"Still fine","fields":{"priority":"low"}}`)
	if _, err := f.CreateArtifact(ctx, model.KindEntry, must(parse(`{"path":"good","type":"requirement","title":"dup","hid":"REQ-1","fields":{"priority":"low"}}`))); !errors.Is(err, model.ErrConflict) {
		t.Fatalf("duplicate hid after push: %v", err)
	}
	live := dump(t, f.DB)
	if err := f.DB.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	if dump(t, f.DB) != live {
		t.Fatalf("hostile content: live differs from rebuild\n%s", diffLines(live, dump(t, f.DB)))
	}
	// A rewind (force push backwards) is detected and rebuilt.
	if err := f.Repo.Publish(ctx, mustHead(t, f), head); err != nil {
		t.Fatal(err)
	}
	if err := f.DB.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if ph, _ := f.DB.ProcessedHash(ctx); ph != head {
		t.Fatalf("after rewind processed=%s want %s", ph, head)
	}
	if _, err := f.Get(ctx, g2); !errors.Is(err, model.ErrNotFound) {
		t.Fatal("rewound content still projected")
	}
}

// TestWritesDuringReindex: writers see maintenance mode or succeed, never
// corrupt the projection.
func TestWritesDuringReindex(t *testing.T) {
	f := open(t)
	ctx := context.Background()
	seed(t, f)
	for i := 0; i < 40; i++ {
		create(t, f, model.KindEntry, fmt.Sprintf(`{"path":"load/%d","type":"requirement","title":"L%d","fields":{"priority":"low"}}`, i%5, i))
	}
	var wg sync.WaitGroup
	var maint, okc int
	var mu sync.Mutex
	wg.Add(1)
	go func() { defer wg.Done(); _ = f.DB.Reindex(ctx) }()
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := f.CreateArtifact(ctx, model.KindEntry, must(parse(fmt.Sprintf(`{"path":"load/x","type":"requirement","title":"W%d","fields":{"priority":"low"}}`, i))))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				okc++
			case errors.Is(err, model.ErrMaintenance):
				maint++
			default:
				t.Errorf("unexpected error during reindex: %v", err)
			}
		}(i)
	}
	wg.Wait()
	if err := f.DB.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	live := dump(t, f.DB)
	if err := f.DB.Reindex(ctx); err != nil {
		t.Fatal(err)
	}
	if dump(t, f.DB) != live {
		t.Fatal("projection diverged after writes during reindex")
	}
	_, total, _ := f.Search(ctx, projection.Query{Folder: "load", Subtree: true, Limit: 1})
	if total != 40+okc {
		t.Fatalf("total %d, ok %d, maintenance %d", total, okc, maint)
	}
}

func diffLines(a, b string) string {
	al, bl := strings.Split(a, "\n"), strings.Split(b, "\n")
	set := map[string]bool{}
	for _, l := range bl {
		set[l] = true
	}
	var out []string
	for _, l := range al {
		if !set[l] {
			out = append(out, "- "+l)
		}
	}
	set = map[string]bool{}
	for _, l := range al {
		set[l] = true
	}
	for _, l := range bl {
		if !set[l] {
			out = append(out, "+ "+l)
		}
	}
	return strings.Join(out, "\n")
}
