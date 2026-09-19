// Command corestone serves Corestone: a bare Git repository as
// the source of truth, a PostgreSQL projection for queries, the REST and
// WebSocket APIs, and (optionally) the built web client.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/httpapi"
)

// version is set at build time: go build -ldflags "-X main.version=1.2.3".
var version = "dev"

func main() {
	var (
		repo      = flag.String("repo", envOr("CORESTONE_REPO", "data/corestone.git"), "path of the bare Git repository (created if missing)")
		branch    = flag.String("branch", envOr("CORESTONE_BRANCH", "main"), "branch the Foundation owns")
		dsn       = flag.String("db", os.Getenv("CORESTONE_DB"), "PostgreSQL connection string (required), e.g. postgres://user:pass@localhost/corestone?sslmode=disable")
		addr      = flag.String("addr", envOr("CORESTONE_ADDR", "127.0.0.1:8080"), "listen address")
		web       = flag.String("web", envOr("CORESTONE_WEB", "web/dist"), "directory with the built web client (empty to disable)")
		watch     = flag.Duration("watch", envDuration("CORESTONE_WATCH", 3*time.Second), "how often to check for direct Git pushes (0 disables)")
		origins   = flag.String("allow-origin", os.Getenv("CORESTONE_ALLOW_ORIGIN"), "comma-separated extra origins allowed to open WebSocket sessions (same-origin is always allowed)")
		accessLog = flag.Bool("access-log", os.Getenv("CORESTONE_ACCESS_LOG") == "1", "log every HTTP request")
		showVer   = flag.Bool("version", false, "print the version and exit")
	)
	flag.Parse()
	if *showVer {
		fmt.Println("corestone", version)
		return
	}
	if *dsn == "" {
		fmt.Fprintln(os.Stderr, "corestone: -db (or CORESTONE_DB) is required: the PostgreSQL projection database")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	f, err := foundation.Open(ctx, *repo, *branch, *dsn)
	if err != nil {
		log.Fatalf("corestone: %v", err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			log.Printf("corestone: close: %v", err)
		}
	}()
	if *watch > 0 {
		go f.Watch(ctx, *watch)
	}

	api := httpapi.New(f)
	api.Version = version
	if *origins != "" {
		for _, o := range strings.Split(*origins, ",") {
			if o = strings.TrimSpace(o); o != "" {
				api.Hub.OriginPatterns = append(api.Hub.OriginPatterns, o)
			}
		}
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", api)
	if *web != "" {
		if st, err := os.Stat(filepath.Join(*web, "index.html")); err == nil && !st.IsDir() {
			mux.Handle("/", spa(*web))
			log.Printf("corestone: serving web client from %s", *web)
		} else {
			log.Printf("corestone: no web client at %s (API only)", *web)
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "Corestone API: see /api/repository", http.StatusNotFound)
			})
		}
	}
	handler := secureHeaders(mux)
	if *accessLog {
		handler = logRequests(handler)
	}
	srv := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		<-ctx.Done()
		log.Printf("corestone: shutting down")
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdown); err != nil {
			log.Printf("corestone: shutdown: %v", err)
		}
		api.Hub.Close()
	}()
	log.Printf("corestone %s: repository %s (branch %s), listening on http://%s", version, *repo, *branch, *addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("corestone: %v", err)
	}
	<-done
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Fatalf("corestone: %s: %v", key, err)
	}
	return d
}

// secureHeaders adds the response headers every deployment should send.
// The content security policy only covers the web client's own documents;
// API responses are JSON and attachments carry their own policy.
func secureHeaders(next http.Handler) http.Handler {
	const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
		"connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Content-Security-Policy", csp)
		}
		next.ServeHTTP(w, r)
	})
}

// logRequests writes one line per request: method, path, status, size, time.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %dB %s %s", r.Method, r.URL.RequestURI(), rec.status, rec.bytes, time.Since(start).Round(time.Millisecond), clientIP(r))
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusRecorder) WriteHeader(code int) { s.status = code; s.ResponseWriter.WriteHeader(code) }
func (s *statusRecorder) Write(b []byte) (int, error) {
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach Hijack/Flush for WebSockets.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	return r.RemoteAddr
}

// spa serves static files and falls back to index.html for client routes.
func spa(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css") {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fs.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
	})
}
