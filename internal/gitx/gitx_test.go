package gitx

import (
	"context"
	"errors"
	"testing"
)

func newRepo(t *testing.T) *Repo {
	t.Helper()
	r, err := Open(t.TempDir()+"/repo.git", "main")
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestCommitCycle(t *testing.T) {
	ctx := context.Background()
	r := newRepo(t)
	head, err := r.Head(ctx)
	if err != nil || head != "" {
		t.Fatalf("unborn head = %q, %v", head, err)
	}
	c1, err := r.BuildCommit(ctx, "", "first\n\nCorestone-Op: create\nCorestone-Guid: abc\n", []Op{
		{Path: "sp ace/x/.corestone.json", Content: []byte(`{"a":1}`)},
		{Path: "ü/:magic/y.json", Content: []byte(`{"b":1}`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if h, _ := r.Head(ctx); h != "" {
		t.Fatal("BuildCommit must not publish")
	}
	if err := r.Publish(ctx, "", c1); err != nil {
		t.Fatal(err)
	}
	if h, _ := r.Head(ctx); h != c1 {
		t.Fatalf("head=%s want %s", h, c1)
	}
	entries, err := r.ListTree(ctx, c1)
	if err != nil || len(entries) != 2 {
		t.Fatalf("entries=%v err=%v", entries, err)
	}
	if entries[1].Path != "ü/:magic/y.json" {
		t.Fatalf("quotepath leaked: %q", entries[1].Path)
	}
	if entries[0].SHA != BlobSHA([]byte(`{"a":1}`)) {
		t.Fatal("BlobSHA disagrees with git")
	}
	b, sha, err := r.ReadPath(ctx, c1, "ü/:magic/y.json")
	if err != nil || string(b) != `{"b":1}` || sha == "" {
		t.Fatalf("ReadPath: %q %v", b, err)
	}
	// second commit: modify one, delete the other
	c2, err := r.BuildCommit(ctx, c1, "second", []Op{
		{Path: "sp ace/x/.corestone.json", Content: []byte(`{"a":2}`)},
		{Path: "ü/:magic/y.json", Delete: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	// stale CAS
	if err := r.Publish(ctx, "", c2); !errors.Is(err, ErrStale) {
		t.Fatalf("expected ErrStale, got %v", err)
	}
	if err := r.Publish(ctx, c1, c2); err != nil {
		t.Fatal(err)
	}
	changes, err := r.DiffTree(ctx, c1, c2)
	if err != nil || len(changes) != 2 {
		t.Fatalf("changes=%v err=%v", changes, err)
	}
	if changes[0].Status != 'M' || changes[1].Status != 'D' || changes[1].Path != "ü/:magic/y.json" {
		t.Fatalf("unexpected changes %+v", changes)
	}
	root, err := r.DiffTree(ctx, "", c1)
	if err != nil || len(root) != 2 || root[0].Status != 'A' {
		t.Fatalf("root diff %+v %v", root, err)
	}
	chain, err := r.FirstParentChain(ctx, "", c2)
	if err != nil || len(chain) != 2 || chain[0].SHA != c1 || chain[1].Parents[0] != c1 {
		t.Fatalf("chain %+v %v", chain, err)
	}
	chain, _ = r.FirstParentChain(ctx, c1, c2)
	if len(chain) != 1 || chain[0].SHA != c2 {
		t.Fatalf("chain %+v", chain)
	}
	ok, _ := r.IsAncestor(ctx, c1, c2)
	no, _ := r.IsAncestor(ctx, c2, c1)
	if !ok || no {
		t.Fatal("IsAncestor wrong")
	}
	log, err := r.Log(ctx, c2, []string{Literal("sp ace/x/.corestone.json")}, 0)
	if err != nil || len(log) != 2 {
		t.Fatalf("log=%v err=%v", log, err)
	}
	if log[1].Trailers["Corestone-Op"] != "create" || log[1].Body != "" || log[1].Subject != "first" {
		t.Fatalf("trailers not parsed: %+v", log[1])
	}
	log, _ = r.Log(ctx, c2, []string{":(glob)**/y.json"}, 0)
	if len(log) != 2 {
		t.Fatalf("glob log = %d", len(log))
	}
	var walked []CommitDiff
	if err := r.Walk(ctx, c2, func(cd CommitDiff) error { walked = append(walked, cd); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(walked) != 2 || walked[0].SHA != c2 || walked[0].Parent != c1 || len(walked[0].Changes) != 2 || walked[1].Parent != "" || len(walked[1].Changes) != 2 {
		t.Fatalf("walk %+v", walked)
	}
	blobs, err := r.ReadBlobs(ctx, []string{changes[0].SHA, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"})
	if err != nil || string(blobs[changes[0].SHA]) != `{"a":2}` || len(blobs) != 1 {
		t.Fatalf("blobs %v %v", blobs, err)
	}
	if _, _, err := r.ReadPath(ctx, c2, "ü/:magic/y.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted path err=%v", err)
	}
}

func TestBrokenRepoIsNotEmpty(t *testing.T) {
	r := &Repo{Dir: t.TempDir() + "/nope", Branch: "main"}
	if _, err := r.Head(context.Background()); err == nil {
		t.Fatal("missing repository must be an error, not an empty head")
	}
}
