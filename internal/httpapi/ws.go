package httpapi

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/model"
)

// Hub is the WebSocket session service (design guide §7.16.3): it pushes
// transient runtime information to connected clients — repository updates,
// workflow transitions, indexing progress, maintenance mode — and keeps
// lightweight presence (who is viewing or editing which artifact) so
// clients can warn before conflicting edits. It never carries CRUD.
type Hub struct {
	f *foundation.Foundation
	// OriginPatterns lists additional origins (host patterns such as
	// "app.example.com" or "*.example.com") allowed to open a session.
	// Same-origin requests are always accepted; nothing else is by default.
	OriginPatterns []string
	mu             sync.Mutex
	clients        map[*client]struct{}
	closed         bool
}

type client struct {
	conn    *websocket.Conn
	id      string
	name    string
	viewing string
	editing string
	send    chan []byte
}

// NewHub creates the hub and subscribes it to Foundation events.
func NewHub(f *foundation.Foundation) *Hub {
	h := &Hub{f: f, clients: map[*client]struct{}{}}
	f.Subscribe(func(e foundation.Event) { h.broadcast(e) })
	return h
}

func (h *Hub) broadcast(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- data:
		default: // slow client: drop the message rather than block the writer
		}
	}
}

// presenceOf lists viewers and editors of one artifact.
func (h *Hub) presenceOf(guid string) map[string]any {
	var viewers, editors []string
	for c := range h.clients {
		if c.viewing == guid {
			viewers = append(viewers, c.name)
		}
		if c.editing == guid {
			editors = append(editors, c.name)
		}
	}
	sort.Strings(viewers)
	sort.Strings(editors)
	if viewers == nil {
		viewers = []string{}
	}
	if editors == nil {
		editors = []string{}
	}
	return map[string]any{"type": "presence", "guid": guid, "viewers": viewers, "editors": editors, "at": model.Now()}
}

func (h *Hub) announce(guid string) {
	if guid == "" {
		return
	}
	h.mu.Lock()
	msg := h.presenceOf(guid)
	h.mu.Unlock()
	h.broadcast(msg)
}

// Clients returns the number of connected sessions.
func (h *Hub) Clients() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

// Close ends every session and refuses new ones; used at shutdown, since
// hijacked WebSocket connections are outside http.Server.Shutdown.
func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()
	for _, c := range clients {
		_ = c.conn.Close(websocket.StatusGoingAway, "server shutting down")
	}
}

// Serve upgrades the connection and runs the session.
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		writeError(w, http.StatusServiceUnavailable, "server shutting down")
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.OriginPatterns})
	if err != nil {
		return
	}
	c := &client{conn: conn, id: model.NewGUID()[:8], name: "user-" + model.NewGUID()[:4], send: make(chan []byte, 64)}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	ctx, cancel := context.WithCancel(r.Context())
	defer func() {
		cancel()
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		h.announce(c.viewing)
		h.announce(c.editing)
		_ = conn.Close(websocket.StatusNormalClosure, "bye")
	}()

	hello, _ := json.Marshal(map[string]any{"type": "hello", "session": c.id, "name": c.name, "status": h.f.DB.Status(), "at": model.Now()})
	if err := conn.Write(ctx, websocket.MessageText, hello); err != nil {
		return
	}
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case msg := <-c.send:
				wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Write(wctx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			case <-ticker.C:
				pctx, pcancel := context.WithTimeout(ctx, 5*time.Second)
				err := conn.Ping(pctx)
				pcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()
	conn.SetReadLimit(16 << 10)
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg struct {
			Type string `json:"type"`
			Name string `json:"name"`
			GUID string `json:"guid"`
			On   bool   `json:"on"`
		}
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		switch msg.Type {
		case "hello":
			if msg.Name != "" && len(msg.Name) <= 64 {
				h.mu.Lock()
				c.name = msg.Name
				h.mu.Unlock()
			}
		case "view":
			h.mu.Lock()
			prev := c.viewing
			c.viewing = msg.GUID
			h.mu.Unlock()
			h.announce(prev)
			h.announce(msg.GUID)
		case "edit":
			h.mu.Lock()
			prev := c.editing
			if msg.On {
				c.editing = msg.GUID
			} else if c.editing == msg.GUID {
				c.editing = ""
			}
			h.mu.Unlock()
			h.announce(prev)
			h.announce(msg.GUID)
		case "presence":
			h.mu.Lock()
			p := h.presenceOf(msg.GUID)
			h.mu.Unlock()
			if b, err := json.Marshal(p); err == nil {
				select {
				case c.send <- b:
				default:
				}
			}
		default:
			log.Printf("ws: unknown message type %q", msg.Type)
		}
	}
}
