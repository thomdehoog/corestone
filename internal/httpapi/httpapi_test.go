package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/testutil"
)

type api struct {
	t   *testing.T
	srv *httptest.Server
	s   *Server
}

func (a *api) Hub() *Hub { return a.s.Hub }

func newAPI(t *testing.T) *api {
	t.Helper()
	f, err := foundation.Open(context.Background(), t.TempDir()+"/repo.git", "main", testutil.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	s := New(f)
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &api{t: t, srv: srv, s: s}
}

type resp struct {
	code int
	body map[string]any
	raw  []byte
	hdr  http.Header
}

func (a *api) do(method, path string, body string, headers ...string) resp {
	a.t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, a.srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		a.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	r := resp{code: res.StatusCode, raw: raw, hdr: res.Header}
	if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		_ = json.Unmarshal(raw, &r.body)
	}
	return r
}

func (a *api) ok(method, path, body string, want int, headers ...string) resp {
	a.t.Helper()
	r := a.do(method, path, body, headers...)
	if r.code != want {
		a.t.Fatalf("%s %s: got %d want %d: %s", method, path, r.code, want, r.raw)
	}
	return r
}

func meta(r resp, key string) string {
	m, _ := r.body["meta"].(map[string]any)
	s, _ := m[key].(string)
	return s
}

func (a *api) seed() {
	a.ok("PUT", "/api/workflows/dev", `{"id":"dev","initial":"open","states":["open","review","done"],"transitions":[{"id":"submit","from":"open","to":"review"},{"from":"review","to":"done"}]}`, 200)
	a.ok("PUT", "/api/schemas/requirement", `{"type":"requirement","displayName":"Requirement","hid":{"prefix":"REQ"},"workflows":["dev"],
		"fields":[{"id":"priority","type":"enum","required":true,"options":[{"value":"low"},{"value":"high"}]},{"id":"rationale","type":"multiline"}]}`, 200)
	a.ok("PUT", "/api/schemas/testcase", `{"type":"testcase","hid":{"prefix":"TC"}}`, 200)
	a.ok("PUT", "/api/schemas/spec", `{"type":"spec","kind":"document"}`, 200)
	a.ok("PUT", "/api/schemas/verifies", `{"type":"verifies","kind":"link","sourceTypes":["testcase"],"targetTypes":["requirement"],"cardinality":"many-to-many"}`, 200)
}

func TestRESTLifecycle(t *testing.T) {
	a := newAPI(t)
	a.seed()

	// schema name mismatch and invalid schema
	a.ok("PUT", "/api/schemas/other", `{"type":"requirement"}`, 400)
	a.ok("PUT", "/api/schemas/bad", `{"type":"bad","fields":[{"id":"x","type":"nope"}]}`, 400)
	a.ok("PUT", "/api/schemas/x", `not json`, 400)

	r1 := a.ok("POST", "/api/entries", `{"path":"specs/boot","type":"requirement","title":"Boot fast","fields":{"priority":"high"}}`, 201)
	g1 := meta(r1, "guid")
	if meta(r1, "hid") != "REQ-1" || r1.hdr.Get("ETag") == "" || r1.hdr.Get("Location") != "/api/entries/"+g1 {
		t.Fatalf("create response %s %v", r1.raw, r1.hdr)
	}
	etag := r1.hdr.Get("ETag")
	a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"no priority"}`, 400)
	a.ok("POST", "/api/entries", `{"path":"specs","type":"requirement","title":"dup","hid":"REQ-1","fields":{"priority":"low"}}`, 409)
	a.ok("POST", "/api/entries", `[1,2]`, 400)
	a.ok("POST", "/api/entries", strings.Repeat("x", 5<<20), 413)

	// GET with ETag / If-None-Match, kind-checked routes
	g := a.ok("GET", "/api/entries/"+g1, "", 200)
	if g.hdr.Get("ETag") != etag {
		t.Fatalf("etag %s vs %s", g.hdr.Get("ETag"), etag)
	}
	a.ok("GET", "/api/entries/"+g1, "", 304, "If-None-Match", etag)
	a.ok("GET", "/api/documents/"+g1, "", 404)
	a.ok("GET", "/api/artifacts/"+g1, "", 200)
	a.ok("GET", "/api/entries/not-a-guid", "", 404)
	a.ok("GET", "/api/nope", "", 404)

	// PUT with If-Match (quoted, weak, star) → 200 / 412
	u := a.ok("PUT", "/api/entries/"+g1, `{"title":"Boot in 2 s"}`, 200, "If-Match", etag)
	a.ok("PUT", "/api/entries/"+g1, `{"title":"stale"}`, 412, "If-Match", etag)
	a.ok("PUT", "/api/entries/"+g1, `{"fields":{"rationale":"weak"}}`, 200, "If-Match", "W/"+u.hdr.Get("ETag"))
	a.ok("PUT", "/api/entries/"+g1, `{"fields":{"rationale":"star"}}`, 200, "If-Match", "*")
	a.ok("PUT", "/api/entries/"+g1, `{"fields":{"priority":"urgent"}}`, 400)
	a.ok("PUT", "/api/documents/"+g1, `{"title":"x"}`, 404)

	// documents referencing entries
	d := a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"Boot spec","content":[{"type":"section","title":"Timing","children":[{"type":"paragraph","text":"See:"},{"type":"entry","guid":"`+g1+`"}]}]}`, 201)
	gd := meta(d, "guid")
	a.ok("POST", "/api/documents", `{"path":"docs","type":"spec","title":"bad ref","content":[{"type":"entry","guid":"00000000-0000-4000-8000-000000000000"}]}`, 400)
	a.ok("POST", "/api/documents", `{"path":"docs","type":"requirement","title":"wrong kind","fields":{"priority":"low"}}`, 400)

	// links, relationships, comments, workflows
	tc := a.ok("POST", "/api/entries", `{"path":"tests","type":"testcase","title":"Cold boot"}`, 201)
	gt := meta(tc, "guid")
	a.ok("POST", "/api/links", `{"type":"verifies","source":"`+g1+`","target":"`+gt+`"}`, 400)
	l := a.ok("POST", "/api/links", `{"type":"verifies","source":"`+gt+`","target":"`+g1+`"}`, 201)
	a.ok("POST", "/api/links", `{"type":"verifies","source":"`+gt+`","target":"`+g1+`"}`, 409)
	rel := a.ok("GET", "/api/artifacts/"+g1+"/relationships", "", 200)
	if n := len(rel.body["incoming"].([]any)); n != 1 {
		t.Fatalf("incoming %d", n)
	}
	c := a.ok("POST", "/api/comments", `{"subject":"`+g1+`","text":"why?","author":"alice"}`, 201)
	a.ok("POST", "/api/comments", `{"subject":"`+g1+`","parent":"`+meta(c, "guid")+`","text":"because"}`, 201)
	a.ok("POST", "/api/comments", `{"subject":"`+g1+`","text":""}`, 400)
	cm := a.ok("GET", "/api/artifacts/"+g1+"/comments", "", 200)
	if n := len(cm.body["comments"].([]any)); n != 2 {
		t.Fatalf("comments %d", n)
	}
	ws := a.ok("GET", "/api/artifacts/"+g1+"/workflows", "", 200)
	if !strings.Contains(string(ws.raw), `"state":"open"`) {
		t.Fatalf("workflows %s", ws.raw)
	}
	a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"workflow":"dev","to":"done"}`, 400)
	tr := a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"workflow":"dev","to":"review"}`, 200)
	if !strings.Contains(string(tr.raw), `"dev":"review"`) {
		t.Fatalf("transition %s", tr.raw)
	}
	a.ok("POST", "/api/artifacts/"+g1+"/transition", `{"workflow":"dev","to":"done"}`, 412, "If-Match", etag)

	// overlay analysis
	ov := a.ok("POST", "/api/entries", `{"path":"specs/boot","type":"requirement","title":"Variant","base":"`+g1+`","fields":{"priority":"low"}}`, 201)
	an := a.ok("GET", "/api/artifacts/"+meta(ov, "guid")+"/overlay", "", 200)
	if n := len(an.body["chain"].([]any)); n != 2 {
		t.Fatalf("overlay chain %d: %s", n, an.raw)
	}

	// attachments
	a.ok("PUT", "/api/artifacts/"+g1+"/files/notes.txt", "hello world", 204)
	f := a.ok("GET", "/api/artifacts/"+g1+"/files/notes.txt", "", 200)
	if f.hdr.Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
		t.Fatalf("attachments must be sandboxed, got CSP %q", f.hdr.Get("Content-Security-Policy"))
	}
	if string(f.raw) != "hello world" {
		t.Fatalf("attachment %q", f.raw)
	}
	a.ok("GET", "/api/artifacts/"+g1+"/files/missing.txt", "", 404)
	a.ok("PUT", "/api/artifacts/"+g1+"/files/.corestone.json", "x", 400)

	// search, tree, types, effective schema, history, hid lookup, validate, status
	s := a.ok("GET", "/api/repository/search?q=boot&kind=entry", "", 200)
	if s.body["total"].(float64) != 2 {
		t.Fatalf("search %s", s.raw)
	}
	s = a.ok("GET", "/api/repository/search?state.dev=review", "", 200)
	if s.body["total"].(float64) != 1 {
		t.Fatalf("state search %s", s.raw)
	}
	s = a.ok("GET", "/api/repository/search?field.priority=low&path=specs", "", 200)
	if s.body["total"].(float64) != 1 {
		t.Fatalf("field search %s", s.raw)
	}
	a.ok("GET", "/api/repository/search?kind=blob", "", 400)
	tree := a.ok("GET", "/api/repository/tree", "", 200)
	if n := len(tree.body["folders"].([]any)); n != 3 { // docs, specs, tests
		t.Fatalf("tree %s", tree.raw)
	}
	tree = a.ok("GET", "/api/repository/tree?path=specs&subtree=1", "", 200)
	if n := len(tree.body["artifacts"].([]any)); n != 2 {
		t.Fatalf("subtree %s", tree.raw)
	}
	ty := a.ok("GET", "/api/repository/types?path=specs/boot", "", 200)
	if n := len(ty.body["types"].([]any)); n != 4 {
		t.Fatalf("types %s", ty.raw)
	}
	eff := a.ok("GET", "/api/schemas/effective?type=requirement&path=specs/boot", "", 200)
	if eff.body["displayName"] != "Requirement" {
		t.Fatalf("effective %s", eff.raw)
	}
	a.ok("GET", "/api/schemas/effective?type=nope", "", 404)
	so := a.ok("GET", "/api/artifacts/"+g1+"/schema", "", 200)
	if so.body["type"] != "requirement" {
		t.Fatalf("schemaOf %s", so.raw)
	}
	h := a.ok("GET", "/api/artifacts/"+g1+"/history", "", 200)
	if n := len(h.body["history"].([]any)); n < 5 {
		t.Fatalf("history %d", n)
	}
	a.ok("GET", "/api/repository/hids/REQ-1", "", 200)
	a.ok("GET", "/api/repository/hids/REQ-999", "", 404)
	v := a.ok("GET", "/api/repository/validate", "", 200)
	if v.body["errors"].(float64) != 0 {
		t.Fatalf("validate %s", v.raw)
	}
	st := a.ok("GET", "/api/repository", "", 200)
	if st.body["inSync"] != true {
		t.Fatalf("status %s", st.raw)
	}
	sch := a.ok("GET", "/api/schemas", "", 200)
	if n := len(sch.body["schemas"].([]any)); n != 4 {
		t.Fatalf("schemas %s", sch.raw)
	}
	a.ok("GET", "/api/workflows/dev?path=specs", "", 200)
	a.ok("GET", "/api/workflows/nope", "", 404)

	// move artifact and folder
	mv := a.ok("POST", "/api/artifacts/"+g1+"/move", `{"path":"archive"}`, 200)
	if meta(mv, "folder") != "archive" {
		t.Fatalf("move %s", mv.raw)
	}
	a.ok("POST", "/api/artifacts/"+g1+"/move", `{"path":"../x"}`, 400)
	a.ok("POST", "/api/repository/folders/move", `{"from":"specs/boot","to":"specs/startup"}`, 200)
	a.ok("POST", "/api/repository/folders/move", `{"from":"specs","to":"specs/in"}`, 400)
	a.ok("POST", "/api/repository/folders/move", `{"from":"missing","to":"x"}`, 404)
	a.ok("POST", "/api/repository/maintenance/relocate-metadata", "", 200)

	// delete with wrong kind route, precondition, cascade, deleted listing
	a.ok("DELETE", "/api/documents/"+g1, "", 404)
	a.ok("DELETE", "/api/entries/"+g1, "", 412, "If-Match", `"deadbeef"`)
	a.ok("DELETE", "/api/entries/"+g1, "", 204)
	a.ok("GET", "/api/entries/"+g1, "", 404)
	a.ok("GET", "/api/links/"+meta(l, "guid"), "", 404)
	del := a.ok("GET", "/api/repository/deleted", "", 200)
	if n := len(del.body["deleted"].([]any)); n != 4 {
		t.Fatalf("deleted %s", del.raw)
	}
	a.ok("DELETE", "/api/documents/"+gd, "", 204)
	a.ok("DELETE", "/api/schemas/spec", "", 204)
	a.ok("DELETE", "/api/schemas/spec", "", 404)
	a.ok("DELETE", "/api/workflows/dev", "", 204)

	// reindex is accepted and finishes
	a.ok("POST", "/api/repository/reindex", "", 202)
	deadline := time.Now().Add(10 * time.Second)
	for {
		st := a.ok("GET", "/api/repository", "", 200)
		p := st.body["projection"].(map[string]any)
		if p["maintenance"] == false && st.body["inSync"] == true {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("reindex did not finish: %s", st.raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestWebSocketSession(t *testing.T) {
	a := newAPI(t)
	a.seed()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(a.srv.URL, "http") + "/api/ws"
	c1, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c1.CloseNow()
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()
	read := func(c *websocket.Conn) map[string]any {
		t.Helper()
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		return m
	}
	if h := read(c1); h["type"] != "hello" || h["status"] == nil {
		t.Fatalf("hello %v", h)
	}
	read(c2)
	// presence: c2 starts editing an artifact; c1 hears about it
	guid := "11111111-1111-4111-8111-111111111111"
	if err := c2.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","name":"bob"}`)); err != nil {
		t.Fatal(err)
	}
	if err := c2.Write(ctx, websocket.MessageText, []byte(fmt.Sprintf(`{"type":"edit","guid":%q,"on":true}`, guid))); err != nil {
		t.Fatal(err)
	}
	p := read(c1)
	if p["type"] != "presence" || p["guid"] != guid || fmt.Sprint(p["editors"]) != "[bob]" {
		t.Fatalf("presence %v", p)
	}
	// a commit is broadcast to every client
	a.ok("POST", "/api/entries", `{"path":"x","type":"requirement","title":"T","fields":{"priority":"low"}}`, 201)
	for _, c := range []*websocket.Conn{c1, c2} {
		var got map[string]any
		for i := 0; i < 5; i++ {
			got = read(c)
			if got["type"] == "commit" {
				break
			}
		}
		if got["type"] != "commit" || got["op"] != "create" || got["commit"] == "" {
			t.Fatalf("commit event %v", got)
		}
	}
}

func TestHealthReportsVersionAndDatabase(t *testing.T) {
	a := newAPI(t)
	a.s.Version = "test-build"
	r := a.ok("GET", "/api/health", "", 200)
	if r.body["status"] != "ok" || r.body["database"] != true || r.body["version"] != "test-build" {
		t.Fatalf("unexpected health body: %s", r.raw)
	}
	if r.hdr.Get("Cache-Control") != "no-store" {
		t.Fatalf("health must not be cached: %q", r.hdr.Get("Cache-Control"))
	}
}

func TestWebSocketRejectsForeignOrigin(t *testing.T) {
	a := newAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(a.srv.URL, "http") + "/api/ws"
	_, res, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}})
	if err == nil {
		t.Fatal("cross-origin session was accepted")
	}
	if res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 for a foreign origin, got %v", res)
	}
	// Same-origin and explicitly allowed origins connect.
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {a.srv.URL}}})
	if err != nil {
		t.Fatalf("same-origin session refused: %v", err)
	}
	defer c.CloseNow()
	a.s.Hub.OriginPatterns = []string{"app.example.com"}
	c2, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://app.example.com"}}})
	if err != nil {
		t.Fatalf("allowed origin refused: %v", err)
	}
	defer c2.CloseNow()
}

func TestHubCloseEndsSessionsAndRefusesNewOnes(t *testing.T) {
	a := newAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(a.srv.URL, "http") + "/api/ws"
	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if _, _, err := c.Read(ctx); err != nil { // hello
		t.Fatal(err)
	}
	a.s.Hub.Close()
	if _, _, err := c.Read(ctx); err == nil {
		t.Fatal("session survived hub close")
	}
	if _, _, err := websocket.Dial(ctx, url, nil); err == nil {
		t.Fatal("new session accepted after close")
	}
	if n := a.s.Hub.Clients(); n != 0 {
		t.Fatalf("clients after close: %d", n)
	}
}
