package projection

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/thomdehoog/corestone/internal/model"
	"github.com/thomdehoog/corestone/internal/ojson"
	"github.com/thomdehoog/corestone/internal/scanner"
)

const (
	maxSearchBytes = 256 * 1024
	maxFieldValue  = 1024
)

// record is a fully extracted artifact row ready for SQL.
type record struct {
	model.Summary
	BlobSHA string
	States  string // jsonb
	FieldsJ string // jsonb
	Search  string
	Valid   bool
	Error   string
	Index   []fieldKV
	Refs    []string // outgoing references (base, source, target, subject, parent, ref fields, entry blocks)
}

type fieldKV struct{ Field, Value string }

// extract turns a matched artifact file into a record. It never fails: a
// malformed file becomes a row with valid=false so the projection can
// always be rebuilt from whatever Git contains (direct pushes are supported).
func extract(m scanner.Match, sha string, content []byte) *record {
	r := &record{BlobSHA: sha, Valid: true, States: "{}", FieldsJ: "{}"}
	r.Path = m.Path
	r.Folder = m.Folder
	switch m.Category {
	case scanner.Artifact:
		r.GUID = m.GUID
		r.Kind = model.KindEntry
	case scanner.ConfigFile:
		k, _ := scanner.KindOf(m.ConfigKind)
		r.Kind = k
		if model.IsGUID(m.Name) {
			r.GUID = m.Name
		}
	}
	a, err := model.ParseArtifact(content, r.Kind)
	if err != nil {
		r.Valid, r.Error = false, err.Error()
		return r
	}
	if r.GUID != "" && a.GUID != r.GUID {
		r.Error = "guid in file differs from its location"
	}
	r.GUID = a.GUID
	if m.Category == scanner.Artifact && !a.Kind.IsFolderKind() {
		r.Valid, r.Error = false, "kind "+string(a.Kind)+" cannot live in an artifact directory"
		return r
	}
	if m.Category == scanner.ConfigFile && a.Kind != r.Kind {
		r.Valid, r.Error = false, "kind "+string(a.Kind)+" stored under "+m.ConfigKind
		return r
	}
	if verr := a.Validate(); verr != nil {
		r.Valid, r.Error = false, verr.Error()
	}
	r.Kind, r.Type, r.Title, r.HID = a.Kind, a.Type, clean(a.Title), a.HID
	r.Base, r.Source, r.Target, r.Subject, r.Parent = a.Base, a.Source, a.Target, a.Subject, a.Parent
	r.Author, r.Created = clean(a.Author), a.Created
	if a.Workflows != nil {
		r.Workflows = a.Workflows
		if b, err := json.Marshal(a.Workflows); err == nil {
			r.States = clean(string(b))
		}
		for k, v := range a.Workflows {
			r.Index = append(r.Index, fieldKV{"workflow:" + k, trunc(v)})
		}
	}
	if a.Fields != nil {
		plain := ojson.ToPlain(a.Fields)
		if b, err := json.Marshal(plain); err == nil {
			r.FieldsJ = clean(string(b))
		}
		if pm, ok := plain.(map[string]any); ok {
			r.Fields = pm
		}
		for _, k := range a.Fields.Keys() {
			v, _ := a.Fields.Get(k)
			for _, s := range scalarStrings(v) {
				r.Index = append(r.Index, fieldKV{k, trunc(s)})
			}
			r.Refs = append(r.Refs, guidsIn(v)...)
		}
	}
	for _, g := range []string{a.Base, a.Source, a.Target, a.Subject, a.Parent} {
		if g != "" {
			r.Refs = append(r.Refs, g)
		}
	}
	if a.Kind == model.KindDocument {
		r.Refs = append(r.Refs, model.ContentRefs(a.Content)...)
	}
	r.Search = searchText(a)
	return r
}

func searchText(a *model.Artifact) string {
	var b strings.Builder
	add := func(s string) {
		if s == "" || b.Len() > maxSearchBytes {
			return
		}
		b.WriteString(s)
		b.WriteByte('\n')
	}
	add(a.Title)
	add(a.HID)
	add(a.Type)
	add(a.Text)
	add(a.Author)
	if a.Fields != nil {
		var walk func(v any, depth int)
		walk = func(v any, depth int) {
			if depth > 8 || b.Len() > maxSearchBytes {
				return
			}
			switch t := v.(type) {
			case string:
				add(t)
			case []any:
				for _, e := range t {
					walk(e, depth+1)
				}
			case *ojson.Object:
				for _, k := range t.Keys() {
					e, _ := t.Get(k)
					walk(e, depth+1)
				}
			}
		}
		walk(a.Fields, 0)
	}
	if a.Kind == model.KindDocument {
		add(model.ContentText(a.Content))
	}
	s := b.String()
	if len(s) > maxSearchBytes {
		s = s[:maxSearchBytes]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return clean(s)
}

func scalarStrings(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case bool:
		if t {
			return []string{"true"}
		}
		return []string{"false"}
	case json.Number:
		return []string{string(t)}
	case []any:
		var out []string
		for _, e := range t {
			switch s := e.(type) {
			case string:
				out = append(out, s)
			case json.Number:
				out = append(out, string(s))
			case bool:
				out = append(out, scalarStrings(s)...)
			}
		}
		return out
	}
	return nil
}

func guidsIn(v any) []string {
	switch t := v.(type) {
	case string:
		if model.IsGUID(t) {
			return []string{t}
		}
	case []any:
		var out []string
		for _, e := range t {
			if s, ok := e.(string); ok && model.IsGUID(s) {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// clean strips bytes PostgreSQL rejects in text/jsonb (NUL) and invalid UTF-8.
func clean(s string) string {
	if !strings.ContainsRune(s, 0) && utf8.ValidString(s) && !strings.Contains(s, `\u0000`) {
		return s
	}
	s = strings.ReplaceAll(s, "\x00", "")
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	s = strings.ReplaceAll(s, `\u0000`, "")
	return s
}

func trunc(s string) string {
	s = clean(s)
	if len(s) > maxFieldValue {
		s = s[:maxFieldValue]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// ConfigRecord is a projected schema / workflow / scanner file.
type ConfigRecord struct {
	Path     string `json:"path"`
	Scope    string `json:"scope"`
	Category string `json:"category"`
	Name     string `json:"name"`
	BlobSHA  string `json:"etag"`
	Data     []byte `json:"data,omitempty"`
	Valid    bool   `json:"valid"`
	Error    string `json:"error,omitempty"`
}

// extractConfig validates a configuration file for its category.
func extractConfig(m scanner.Match, sha string, content []byte) *ConfigRecord {
	c := &ConfigRecord{Path: m.Path, Scope: m.Folder, Category: m.ConfigKind, Name: m.Name, BlobSHA: sha, Valid: true}
	var err error
	switch m.ConfigKind {
	case scanner.ConfigSchemas:
		var s *model.Schema
		s, err = model.ParseSchema(content)
		if err == nil && s.Type != m.Name {
			err = errors.New("schema type " + s.Type + " does not match file name " + m.Name)
		}
	case scanner.ConfigWorkflows:
		var w *model.Workflow
		w, err = model.ParseWorkflow(content)
		if err == nil && w.ID != m.Name {
			err = errors.New("workflow id " + w.ID + " does not match file name " + m.Name)
		}
	case scanner.ConfigScanner:
		_, err = scanner.ParseConfig(content)
	}
	if err != nil {
		c.Valid, c.Error = false, err.Error()
	}
	if json.Valid(content) {
		c.Data = []byte(clean(string(content)))
	}
	return c
}
