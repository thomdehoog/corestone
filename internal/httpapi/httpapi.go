// Package httpapi is the REST layer of Corestone (design guide
// §6): artifact APIs (CRUD for entries, documents, links, comments) and
// service APIs (search, tree, effective schemas, overlay analysis, workflow
// evaluation, relationship analysis, history, validation, reindex). It is
// deliberately thin: request decoding, ETag/If-Match handling and status
// code mapping; every rule lives in the Foundation.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/thomdehoog/corestone/internal/foundation"
	"github.com/thomdehoog/corestone/internal/gitx"
	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/projection"
)

const (
	maxBody       = 4 << 20
	maxAttachment = 32 << 20
)

// Server serves the API for one Foundation.
type Server struct {
	F   *foundation.Foundation
	Hub *Hub
	// Version is reported by GET /api/health.
	Version string
	mux     *http.ServeMux
}

// New builds the API handler.
func New(f *foundation.Foundation) *Server {
	s := &Server{F: f, Hub: NewHub(f), mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The client names its user (percent-encoded) so commits carry them as author.
	if user, err := url.PathUnescape(r.Header.Get("X-Corestone-User")); err == nil && user != "" {
		r = r.WithContext(gitx.WithAuthor(r.Context(), user))
	}
	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	m := s.mux
	// repository services
	m.HandleFunc("GET /api/health", s.health)
	m.HandleFunc("GET /api/repository", s.status)
	m.HandleFunc("GET /api/repository/tree", s.tree)
	m.HandleFunc("GET /api/repository/search", s.search)
	m.HandleFunc("GET /api/repository/types", s.types)
	m.HandleFunc("GET /api/repository/validate", s.validate)
	m.HandleFunc("POST /api/repository/reindex", s.reindex)
	m.HandleFunc("POST /api/repository/folders/move", s.moveFolder)
	m.HandleFunc("POST /api/repository/maintenance/relocate-metadata", s.relocate)
	m.HandleFunc("GET /api/repository/hids/{hid}", s.hid)
	m.HandleFunc("GET /api/repository/deleted", s.deleted)
	m.HandleFunc("GET /api/ws", s.Hub.Serve)

	// artifact APIs, one collection per kind
	for _, k := range []struct {
		path string
		kind model.Kind
	}{{"entries", model.KindEntry}, {"documents", model.KindDocument}, {"links", model.KindLink}, {"comments", model.KindComment}} {
		kind := k.kind
		m.HandleFunc("POST /api/"+k.path, func(w http.ResponseWriter, r *http.Request) { s.create(w, r, kind) })
		m.HandleFunc("GET /api/"+k.path+"/{guid}", func(w http.ResponseWriter, r *http.Request) { s.get(w, r, kind) })
		m.HandleFunc("PUT /api/"+k.path+"/{guid}", func(w http.ResponseWriter, r *http.Request) { s.update(w, r, kind) })
		m.HandleFunc("PATCH /api/"+k.path+"/{guid}", func(w http.ResponseWriter, r *http.Request) { s.update(w, r, kind) })
		m.HandleFunc("DELETE /api/"+k.path+"/{guid}", func(w http.ResponseWriter, r *http.Request) { s.delete(w, r, kind) })
	}
	m.HandleFunc("GET /api/artifacts/{guid}", func(w http.ResponseWriter, r *http.Request) { s.get(w, r, "") })
	m.HandleFunc("PUT /api/artifacts/{guid}", func(w http.ResponseWriter, r *http.Request) { s.update(w, r, "") })
	m.HandleFunc("PATCH /api/artifacts/{guid}", func(w http.ResponseWriter, r *http.Request) { s.update(w, r, "") })
	m.HandleFunc("DELETE /api/artifacts/{guid}", func(w http.ResponseWriter, r *http.Request) { s.delete(w, r, "") })
	m.HandleFunc("GET /api/artifacts/{guid}/schema", s.schemaOf)
	m.HandleFunc("GET /api/artifacts/{guid}/overlay", s.overlay)
	m.HandleFunc("GET /api/artifacts/{guid}/workflows", s.workflows)
	m.HandleFunc("POST /api/artifacts/{guid}/transition", s.transition)
	m.HandleFunc("GET /api/artifacts/{guid}/relationships", s.relationships)
	m.HandleFunc("GET /api/artifacts/{guid}/comments", s.comments)
	m.HandleFunc("GET /api/artifacts/{guid}/history", s.history)
	m.HandleFunc("POST /api/artifacts/{guid}/move", s.move)
	m.HandleFunc("GET /api/artifacts/{guid}/files/{name}", s.getFile)
	m.HandleFunc("PUT /api/artifacts/{guid}/files/{name}", s.putFile)
	m.HandleFunc("DELETE /api/artifacts/{guid}/files/{name}", s.deleteFile)

	// configuration
	m.HandleFunc("GET /api/schemas", s.listSchemas)
	m.HandleFunc("GET /api/schemas/effective", s.effectiveSchema)
	m.HandleFunc("PUT /api/schemas/{type}", s.putSchema)
	m.HandleFunc("DELETE /api/schemas/{type}", s.deleteSchema)
	m.HandleFunc("GET /api/workflows", s.listWorkflows)
	m.HandleFunc("GET /api/workflows/{id}", s.getWorkflow)
	m.HandleFunc("PUT /api/workflows/{id}", s.putWorkflow)
	m.HandleFunc("DELETE /api/workflows/{id}", s.deleteWorkflow)

	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "no such endpoint")
	})
}

// ---- helpers --------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg, "status": status})
}

// fail maps domain errors to status codes. Internal details are logged,
// never sent.
func fail(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, context.Canceled):
		// The client went away (navigation, abort): nothing to report.
		writeError(w, 499, "client closed request")
		return
	case errors.Is(err, context.DeadlineExceeded):
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusGatewayTimeout, "the request took too long")
		return
	case errors.Is(err, model.ErrNotFound):
		writeError(w, http.StatusNotFound, strip(err, model.ErrNotFound, "not found"))
	case errors.Is(err, model.ErrValidation):
		writeError(w, http.StatusBadRequest, strip(err, model.ErrValidation, "validation failed"))
	case errors.Is(err, model.ErrPrecondition):
		writeError(w, http.StatusPreconditionFailed, strip(err, model.ErrPrecondition, "precondition failed"))
	case errors.Is(err, model.ErrMaintenance):
		w.Header().Set("Retry-After", "5")
		writeError(w, http.StatusServiceUnavailable, strip(err, model.ErrMaintenance, "repository is in maintenance mode"))
	case errors.Is(err, model.ErrConflict):
		writeError(w, http.StatusConflict, strip(err, model.ErrConflict, "conflict"))
	case errors.Is(err, model.ErrUnavailable):
		w.Header().Set("Retry-After", "5")
		log.Printf("httpapi: unavailable: %v", err)
		writeError(w, http.StatusServiceUnavailable, "projection temporarily unavailable")
	default:
		log.Printf("httpapi: internal error: %v", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}

// strip renders "<sentinel>: detail" as "detail" (or a default).
func strip(err, sentinel error, def string) string {
	msg := err.Error()
	if i := strings.Index(msg, sentinel.Error()+": "); i >= 0 {
		return msg[i+len(sentinel.Error())+2:]
	}
	if msg == sentinel.Error() {
		return def
	}
	return msg
}

func readObject(w http.ResponseWriter, r *http.Request) (*ojson.Object, bool) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large or unreadable")
		return nil, false
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return ojson.NewObject(), true
	}
	o, err := ojson.ParseObject(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, "request body must be a JSON object: "+err.Error())
		return nil, false
	}
	return o, true
}

// ifMatch extracts the expected ETag from If-Match (RFC 9110: quoted,
// optionally weak, "*" or a list; the first tag wins for a list).
func ifMatch(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("If-Match"))
	if h == "" {
		return ""
	}
	if h == "*" {
		return "*"
	}
	first := strings.TrimSpace(strings.Split(h, ",")[0])
	first = strings.TrimPrefix(first, "W/")
	return strings.Trim(first, `"`)
}

func setETag(w http.ResponseWriter, etag string) {
	if etag != "" {
		w.Header().Set("ETag", `"`+etag+`"`)
	}
}

// guidParam validates the {guid} path value; invalid values are 404s.
func guidParam(w http.ResponseWriter, r *http.Request) (string, bool) {
	g, err := model.NormalizeGUID(r.PathValue("guid"))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return "", false
	}
	return g, true
}

func intParam(r *http.Request, name string, def int) int {
	if v := r.URL.Query().Get(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func boolParam(r *http.Request, name string, def bool) bool {
	v := r.URL.Query().Get(name)
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// ---- artifact APIs --------------------------------------------------------

func (s *Server) create(w http.ResponseWriter, r *http.Request, kind model.Kind) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	var v *foundation.View
	var err error
	switch kind {
	case model.KindLink:
		v, err = s.F.CreateLink(r.Context(), body)
	case model.KindComment:
		v, err = s.F.CreateComment(r.Context(), body)
	default:
		v, err = s.F.CreateArtifact(r.Context(), kind, body)
	}
	if err != nil {
		fail(w, err)
		return
	}
	setETag(w, v.ETag)
	w.Header().Set("Location", "/api/"+collection(v.Meta.Kind)+"/"+v.Meta.GUID)
	writeJSON(w, http.StatusCreated, v)
}

func collection(k model.Kind) string {
	switch k {
	case model.KindEntry:
		return "entries"
	case model.KindDocument:
		return "documents"
	case model.KindLink:
		return "links"
	case model.KindComment:
		return "comments"
	}
	return "artifacts"
}

func (s *Server) get(w http.ResponseWriter, r *http.Request, kind model.Kind) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	v, err := s.F.Get(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return
	}
	if kind != "" && v.Meta.Kind != kind {
		writeError(w, http.StatusNotFound, "no "+string(kind)+" with this GUID")
		return
	}
	setETag(w, v.ETag)
	if inm := ifNoneMatch(r); inm != "" && inm == v.ETag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func ifNoneMatch(r *http.Request) string {
	h := strings.TrimSpace(r.Header.Get("If-None-Match"))
	if h == "" || h == "*" {
		return ""
	}
	return strings.Trim(strings.TrimPrefix(strings.TrimSpace(strings.Split(h, ",")[0]), "W/"), `"`)
}

func (s *Server) update(w http.ResponseWriter, r *http.Request, kind model.Kind) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	if kind != "" {
		if !s.checkKind(w, r, guid, kind) {
			return
		}
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	v, err := s.F.UpdateArtifact(r.Context(), guid, ifMatch(r), body)
	if err != nil {
		fail(w, err)
		return
	}
	setETag(w, v.ETag)
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) checkKind(w http.ResponseWriter, r *http.Request, guid string, kind model.Kind) bool {
	loc, err := s.F.DB.Locate(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return false
	}
	if loc.Kind != kind {
		writeError(w, http.StatusNotFound, "no "+string(kind)+" with this GUID")
		return false
	}
	return true
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request, kind model.Kind) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	if kind != "" && !s.checkKind(w, r, guid, kind) {
		return
	}
	if err := s.F.DeleteArtifact(r.Context(), guid, ifMatch(r)); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) schemaOf(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	eff, loc, err := s.F.SchemaOf(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema": eff, "type": loc.Type, "folder": loc.Folder, "kind": loc.Kind})
}

func (s *Server) overlay(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	ov, err := s.F.Overlay(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) workflows(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	ws, err := s.F.Workflows(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": ws})
}

func (s *Server) transition(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	v, err := s.F.Transition(r.Context(), guid, body.String("workflow"), body.String("to"), ifMatch(r))
	if err != nil {
		fail(w, err)
		return
	}
	setETag(w, v.ETag)
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) relationships(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	rel, err := s.F.Relationships(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rel)
}

func (s *Server) comments(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	c, err := s.F.Comments(r.Context(), guid)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": c})
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	h, err := s.F.History(r.Context(), guid, intParam(r, "limit", 200))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"history": h})
}

func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	v, err := s.F.MoveArtifact(r.Context(), guid, body.String("path"))
	if err != nil {
		fail(w, err)
		return
	}
	setETag(w, v.ETag)
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	data, sha, err := s.F.Attachment(r.Context(), guid, r.PathValue("name"))
	if err != nil {
		fail(w, err)
		return
	}
	setETag(w, sha)
	w.Header().Set("Content-Type", http.DetectContentType(data))
	w.Header().Set("Content-Disposition", "inline; filename=\""+strings.ReplaceAll(r.PathValue("name"), `"`, "")+"\"")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Attachments are user content served from the application origin: a
	// sandboxed policy keeps an uploaded HTML file from running as the app.
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	_, _ = w.Write(data)
}

func (s *Server) putFile(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxAttachment))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "attachment too large")
		return
	}
	if err := s.F.PutAttachment(r.Context(), guid, r.PathValue("name"), data); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request) {
	guid, ok := guidParam(w, r)
	if !ok {
		return
	}
	if err := s.F.DeleteAttachment(r.Context(), guid, r.PathValue("name")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- repository services --------------------------------------------------

// health is the liveness/readiness probe: 200 while the projection
// database answers, 503 otherwise. Maintenance mode is reported but is not
// a failure: the API keeps serving what the current phase allows.
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	st := s.F.DB.Status()
	body := map[string]any{
		"status":      "ok",
		"version":     s.Version,
		"database":    true,
		"maintenance": st.Maintenance,
		"sessions":    s.Hub.Clients(),
	}
	if err := s.F.DB.Ping(ctx); err != nil {
		body["status"] = "unavailable"
		body["database"] = false
		writeJSON(w, http.StatusServiceUnavailable, body)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	st, err := s.F.Status(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) tree(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	t, err := s.F.Tree(r.Context(), q.Get("path"), boolParam(r, "subtree", false), intParam(r, "limit", projection.DefaultLimit), intParam(r, "offset", 0))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, t)
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	qs := r.URL.Query()
	q := projection.Query{
		Text:    qs.Get("q"),
		Type:    qs.Get("type"),
		Folder:  qs.Get("path"),
		Subtree: boolParam(r, "subtree", true),
		HID:     qs.Get("hid"),
		Sort:    qs.Get("sort"),
		Limit:   intParam(r, "limit", projection.DefaultLimit),
		Offset:  intParam(r, "offset", 0),
	}
	for _, k := range qs["kind"] {
		for _, part := range strings.Split(k, ",") {
			if part = strings.TrimSpace(part); part != "" {
				kind, err := model.ParseKind(part)
				if err != nil {
					fail(w, err)
					return
				}
				q.Kinds = append(q.Kinds, kind)
			}
		}
	}
	for key, vals := range qs {
		switch {
		case strings.HasPrefix(key, "field."):
			if q.Fields == nil {
				q.Fields = map[string]string{}
			}
			q.Fields[strings.TrimPrefix(key, "field.")] = vals[0]
		case strings.HasPrefix(key, "state."):
			if q.States == nil {
				q.States = map[string]string{}
			}
			q.States[strings.TrimPrefix(key, "state.")] = vals[0]
		}
	}
	if v := qs.Get("valid"); v != "" {
		b := boolParam(r, "valid", true)
		q.Valid = &b
	}
	res, total, err := s.F.Search(r.Context(), q)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"artifacts": res, "total": total, "limit": q.Limit, "offset": q.Offset})
}

func (s *Server) types(w http.ResponseWriter, r *http.Request) {
	types, err := s.F.Types(r.Context(), r.URL.Query().Get("path"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"types": types})
}

func (s *Server) validate(w http.ResponseWriter, r *http.Request) {
	issues, err := s.F.DB.Validate(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	errs := 0
	for _, i := range issues {
		if i.Severity == "error" {
			errs++
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"issues": issues, "errors": errs, "warnings": len(issues) - errs})
}

func (s *Server) reindex(w http.ResponseWriter, r *http.Request) {
	if s.F.DB.Maintenance() {
		fail(w, model.ErrMaintenance)
		return
	}
	s.F.Reindex()
	writeJSON(w, http.StatusAccepted, map[string]any{"started": true})
}

func (s *Server) moveFolder(w http.ResponseWriter, r *http.Request) {
	body, ok := readObject(w, r)
	if !ok {
		return
	}
	n, err := s.F.MoveFolder(r.Context(), body.String("from"), body.String("to"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"moved": n})
}

func (s *Server) relocate(w http.ResponseWriter, r *http.Request) {
	n, err := s.F.RelocateMetadata(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"relocated": n})
}

func (s *Server) hid(w http.ResponseWriter, r *http.Request) {
	hid := r.PathValue("hid")
	if err := model.ValidateHID(hid); err != nil {
		fail(w, err)
		return
	}
	recs, err := s.F.HIDLookup(r.Context(), hid)
	if err != nil {
		fail(w, err)
		return
	}
	if len(recs) == 0 {
		writeError(w, http.StatusNotFound, "no artifact ever carried this HID")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hid": r.PathValue("hid"), "records": recs})
}

func (s *Server) deleted(w http.ResponseWriter, r *http.Request) {
	filter := ""
	if q := r.URL.Query().Get("guid"); q != "" {
		g, err := model.NormalizeGUID(q)
		if err != nil {
			fail(w, err)
			return
		}
		filter = g
	}
	d, err := s.F.DB.Deleted(r.Context(), filter, intParam(r, "limit", 200))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": d})
}

// ---- configuration --------------------------------------------------------

func (s *Server) listSchemas(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	files, err := s.F.SchemaFiles(r.Context(), q.Get("scope"), q.Get("scope") == "" && !boolParam(r, "rootOnly", false))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schemas": configOut(files)})
}

func configOut(files []projection.ConfigRecord) []map[string]any {
	out := make([]map[string]any, 0, len(files))
	for _, f := range files {
		m := map[string]any{"path": f.Path, "scope": f.Scope, "name": f.Name, "etag": f.BlobSHA, "valid": f.Valid}
		if f.Error != "" {
			m["error"] = f.Error
		}
		if f.Data != nil {
			m["definition"] = json.RawMessage(f.Data)
		}
		out = append(out, m)
	}
	return out
}

func (s *Server) effectiveSchema(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	eff, err := s.F.EffectiveSchema(r.Context(), q.Get("type"), q.Get("path"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, eff)
}

func (s *Server) putSchema(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	sc, err := s.F.PutSchema(r.Context(), r.URL.Query().Get("scope"), r.PathValue("type"), data)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sc)
}

func (s *Server) deleteSchema(w http.ResponseWriter, r *http.Request) {
	if err := s.F.DeleteSchema(r.Context(), r.URL.Query().Get("scope"), r.PathValue("type")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listWorkflows(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	files, err := s.F.WorkflowFiles(r.Context(), q.Get("scope"), q.Get("scope") == "" && !boolParam(r, "rootOnly", false))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workflows": configOut(files)})
}

func (s *Server) getWorkflow(w http.ResponseWriter, r *http.Request) {
	wf, err := s.F.WorkflowDef(r.Context(), r.PathValue("id"), r.URL.Query().Get("path"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, wf)
}

func (s *Server) putWorkflow(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	wf, err := s.F.PutWorkflow(r.Context(), r.URL.Query().Get("scope"), r.PathValue("id"), data)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, wf)
}

func (s *Server) deleteWorkflow(w http.ResponseWriter, r *http.Request) {
	if err := s.F.DeleteWorkflow(r.Context(), r.URL.Query().Get("scope"), r.PathValue("id")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
