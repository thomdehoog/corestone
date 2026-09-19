package httpapi

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// HTTP-level abuse: limits, malformed requests, injection-shaped query
// parameters, path tricks, and a misbehaving WebSocket client.
func TestHTTPAbuse(t *testing.T) {
	a := newAPI(t)
	a.seed()
	r := a.ok("POST", "/api/entries", `{"path":"x","type":"requirement","title":"T","fields":{"priority":"low"}}`, 201)
	g := meta(r, "guid")

	// bodies
	a.ok("POST", "/api/entries", `{"path":"x","type":"requirement","title":"T","fields":{"priority":"low"}}}}}`, 400)
	a.ok("POST", "/api/entries", `null`, 400)
	a.ok("POST", "/api/entries", `"string"`, 400)
	a.ok("POST", "/api/entries", `{"path":"x","type":"requirement","title":"T","fields":{"priority":"low"},"x":`+strings.Repeat("[", 100000)+strings.Repeat("]", 100000)+`}`, 400)
	a.ok("POST", "/api/entries", "\xff\xfe{}", 400)
	a.ok("PUT", "/api/artifacts/"+g+"/files/big.bin", strings.Repeat("x", 33<<20), 413)
	a.ok("PUT", "/api/schemas/x", strings.Repeat("{", 5<<20), 413)

	// query parameters with hostile values are harmless
	for _, q := range []string{
		"q=%27%3B%20DROP%20TABLE%20artifacts%3B%20--", "q=%00", "q=" + strings.Repeat("a", 20000), "kind=entry,,,", "kind=%27",
		"limit=-1", "limit=999999999", "offset=-5", "offset=abc", "sort=guid;DROP", "field.priority%27=x", "state.dev%22=x",
		"path=..%2F..", "path=%2Fetc%2Fpasswd", "path=" + strings.Repeat("a/", 100), "valid=maybe", "subtree=2",
	} {
		res := a.do("GET", "/api/repository/search?"+q, "")
		if res.code != 200 && res.code != 400 {
			t.Errorf("search?%s → %d %s", q, res.code, res.raw)
		}
	}
	// the table is still there
	a.ok("GET", "/api/entries/"+g, "", 200)

	// path tricks
	for _, p := range []string{
		"/api/artifacts/" + g + "/files/..%2F..%2F.corestone.json", "/api/artifacts/" + g + "/files/%2e%2e", "/api/artifacts/" + g + "/files/.corestone.json",
		"/api/schemas/%2e%2e%2fx", "/api/schemas/..", "/api/schemas/.hidden", "/api/workflows/a%2Fb", "/api/repository/hids/%00",
	} {
		res := a.do("GET", p, "")
		if res.code != 400 && res.code != 404 {
			t.Errorf("GET %s → %d", p, res.code)
		}
		res = a.do("PUT", p, `{"type":"x"}`)
		if res.code != 400 && res.code != 404 && res.code != 405 {
			t.Errorf("PUT %s → %d", p, res.code)
		}
	}
	// header tricks
	a.ok("PUT", "/api/entries/"+g, `{"title":"a"}`, 412, "If-Match", `"`+strings.Repeat("f", 40)+`"`)
	a.ok("PUT", "/api/entries/"+g, `{"title":"b"}`, 412, "If-Match", `W/"nope", "also"`)
	a.ok("PUT", "/api/entries/"+g, `{"title":"c"}`, 200, "If-Match", `*`)
	a.ok("PUT", "/api/entries/"+g, `{"guid":"11111111-1111-4111-8111-111111111111"}`, 400)
	a.ok("PUT", "/api/entries/"+g, `{"kind":"link"}`, 400)
	a.ok("PUT", "/api/entries/"+g, `{"workflows":{"dev":"done"}}`, 400)
	a.ok("PUT", "/api/entries/"+g, `{"fields":"not an object"}`, 200)   // ignored, no change
	a.ok("PUT", "/api/entries/"+g, `{"fields":{"priority":null}}`, 400) // required field removed
	a.ok("PUT", "/api/entries/"+g, `{"title":"tab\tok\nnewline"}`, 200)
	a.ok("PUT", "/api/entries/"+g, `{"title":"bell\u0007"}`, 400)
	a.ok("POST", "/api/artifacts/"+g+"/move", `{"path":"x/`+strings.Repeat("y", 300)+`"}`, 400)
	a.ok("POST", "/api/repository/folders/move", `{"from":"","to":"y"}`, 400)
	a.ok("POST", "/api/repository/folders/move", `{"from":"x","to":".corestone"}`, 400)
	a.ok("POST", "/api/links", `{"type":"related","source":"`+g+`","target":"`+g+`"}`, 400)
	a.ok("POST", "/api/comments", `{"subject":"`+g+`","text":"`+strings.Repeat("c", 300*1024)+`"}`, 400)
	a.ok("POST", "/api/comments", `{"subject":"`+strings.ToUpper(g)+`","text":"upper-case guid is fine"}`, 201)
	a.ok("GET", "/api/entries/"+strings.ToUpper(g), "", 200)

	// unknown methods / endpoints
	if c := a.do("PATCH", "/api/repository", "").code; c != 404 && c != 405 {
		t.Errorf("PATCH /api/repository → %d", c)
	}
	if c := a.do("GET", "/api/entries", "").code; c != 404 && c != 405 {
		t.Errorf("GET /api/entries → %d", c)
	}
	a.ok("GET", "/api/../etc/passwd", "", 404)

	// many concurrent readers and writers do not wedge the server
	done := make(chan int, 40)
	for i := 0; i < 40; i++ {
		go func(i int) {
			var res resp
			if i%4 == 0 {
				res = a.do("POST", "/api/entries", fmt.Sprintf(`{"path":"load","type":"requirement","title":"L%d","fields":{"priority":"low"}}`, i))
			} else {
				res = a.do("GET", "/api/repository/search?q=L&path=load", "")
			}
			done <- res.code
		}(i)
	}
	for i := 0; i < 40; i++ {
		if c := <-done; c != 200 && c != 201 {
			t.Errorf("under load: %d", c)
		}
	}
	st := a.ok("GET", "/api/repository", "", 200)
	if st.body["inSync"] != true {
		t.Fatalf("out of sync after load: %s", st.raw)
	}
	v := a.ok("GET", "/api/repository/validate", "", 200)
	if v.body["errors"].(float64) != 0 {
		t.Fatalf("validation errors after abuse: %s", v.raw)
	}
}

func TestWebSocketAbuse(t *testing.T) {
	a := newAPI(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
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
	for _, msg := range []string{"garbage", `{"type":"view","guid":"` + strings.Repeat("g", 5000) + `"}`, `{"type":"hello","name":"` + strings.Repeat("n", 500) + `"}`, `[]`, `{"type":"edit","on":"yes"}`} {
		if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
			t.Fatal(err)
		}
	}
	// an oversized frame closes only this client
	c2, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c2.CloseNow()
	_ = c2.Write(ctx, websocket.MessageText, []byte(`{"type":"hello","name":"`+strings.Repeat("x", 40000)+`"}`))
	// the first client still receives broadcasts
	a.seed()
	a.ok("POST", "/api/entries", `{"path":"w","type":"requirement","title":"T","fields":{"priority":"low"}}`, 201)
	got := false
	for i := 0; i < 10 && !got; i++ {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("healthy client lost its connection: %v", err)
		}
		got = strings.Contains(string(data), `"type":"commit"`)
	}
	if !got {
		t.Fatal("no commit event after abuse")
	}
	if a.Hub().Clients() < 1 {
		t.Fatal("healthy client dropped")
	}
}
