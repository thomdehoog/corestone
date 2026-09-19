package model

import (
	"strings"
	"time"
	"unicode"

	"github.com/thomdehoog/corestone/internal/ojson"
)

// Artifact is a typed view over an artifact's JSON document. The document
// (Doc) stays authoritative: writes modify it in place so unknown
// properties and key order survive (design guide §3.16).
type Artifact struct {
	Doc  *ojson.Object `json:"-"`
	GUID string        `json:"guid"`
	Kind Kind          `json:"kind"`
	Type string        `json:"type"`

	// entries and documents
	Title string `json:"title,omitempty"`
	HID   string `json:"hid,omitempty"`
	Base  string `json:"base,omitempty"` // entry overlay base

	// links
	Source string `json:"source,omitempty"`
	Target string `json:"target,omitempty"`

	// comments
	Subject string        `json:"subject,omitempty"`
	Parent  string        `json:"parent,omitempty"`
	Author  string        `json:"author,omitempty"`
	Text    string        `json:"text,omitempty"`
	Created string        `json:"created,omitempty"`
	Anchor  *ojson.Object `json:"anchor,omitempty"`

	Fields    *ojson.Object     `json:"fields,omitempty"`
	Workflows map[string]string `json:"workflows,omitempty"`
	Content   []any             `json:"content,omitempty"` // document blocks
}

// ParseArtifact decodes an artifact file. The kind is taken from the
// document, or defaulted from where the file was found.
func ParseArtifact(data []byte, defaultKind Kind) (*Artifact, error) {
	doc, err := ojson.ParseObject(data)
	if err != nil {
		return nil, Invalid("artifact is not a JSON object: %v", err)
	}
	return ArtifactFromDoc(doc, defaultKind)
}

// ArtifactFromDoc builds the typed view of a parsed document.
func ArtifactFromDoc(doc *ojson.Object, defaultKind Kind) (*Artifact, error) {
	a := &Artifact{Doc: doc}
	a.GUID = strings.ToLower(doc.String("guid"))
	if !IsGUID(a.GUID) {
		return nil, Invalid("artifact has no valid guid")
	}
	kind := doc.String("kind")
	if kind == "" {
		a.Kind = defaultKind
	} else {
		k, err := ParseKind(kind)
		if err != nil {
			return nil, err
		}
		a.Kind = k
	}
	a.Type = doc.String("type")
	a.Title = doc.String("title")
	a.HID = doc.String("hid")
	a.Base = strings.ToLower(doc.String("base"))
	a.Source = strings.ToLower(doc.String("source"))
	a.Target = strings.ToLower(doc.String("target"))
	a.Subject = strings.ToLower(doc.String("subject"))
	a.Parent = strings.ToLower(doc.String("parent"))
	a.Author = doc.String("author")
	a.Text = doc.String("text")
	a.Created = doc.String("created")
	a.Anchor = doc.Object("anchor")
	a.Fields = doc.Object("fields")
	if wf := doc.Object("workflows"); wf != nil {
		a.Workflows = map[string]string{}
		for _, k := range wf.Keys() {
			a.Workflows[k] = wf.String(k)
		}
	}
	a.Content = doc.Array("content")
	return a, nil
}

// Validate checks the invariants every stored artifact must satisfy.
func (a *Artifact) Validate() error {
	if a.Type == "" {
		return Invalid("artifact type must not be empty")
	}
	if err := ValidateTypeID(a.Type); err != nil {
		return err
	}
	switch a.Kind {
	case KindEntry, KindDocument:
		if strings.TrimSpace(a.Title) == "" {
			return Invalid("title must not be empty")
		}
		if err := ValidateText("title", a.Title, MaxTitleLen); err != nil {
			return err
		}
		if a.HID != "" {
			if err := ValidateHID(a.HID); err != nil {
				return err
			}
		}
		if a.Base != "" {
			if a.Kind != KindEntry {
				return Invalid("only entries can be overlays")
			}
			if !IsGUID(a.Base) {
				return Invalid("base must be a GUID")
			}
			if a.Base == a.GUID {
				return Invalid("an entry cannot be its own base")
			}
		}
		if a.Kind == KindDocument {
			if err := ValidateContent(a.Content); err != nil {
				return err
			}
		}
	case KindLink:
		if !IsGUID(a.Source) || !IsGUID(a.Target) {
			return Invalid("link needs source and target GUIDs")
		}
	case KindComment:
		if !IsGUID(a.Subject) {
			return Invalid("comment needs a subject GUID")
		}
		if err := ValidateText("text", a.Text, MaxTextLen); err != nil {
			return err
		}
		if err := ValidateText("author", a.Author, MaxTitleLen); err != nil {
			return err
		}
		if a.Parent != "" && !IsGUID(a.Parent) {
			return Invalid("comment parent must be a GUID")
		}
		if strings.TrimSpace(a.Text) == "" {
			return Invalid("comment text must not be empty")
		}
	}
	return nil
}

// Size limits for human-entered text.
const (
	MaxTitleLen = 1024
	MaxTextLen  = 256 * 1024
)

// ValidateText rejects control characters (other than tab and newlines)
// and over-long values in titles and texts.
func ValidateText(what, s string, max int) error {
	if len(s) > max {
		return Invalid("%s longer than %d bytes", what, max)
	}
	for _, r := range s {
		if r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		if r < 0x20 || r == 0x7f || r == unicode.ReplacementChar {
			return Invalid("%s contains control or invalid characters", what)
		}
	}
	return nil
}

// NewDoc creates the JSON document for a fresh artifact in canonical
// property order.
func NewDoc(kind Kind, guid, typ string) *ojson.Object {
	doc := ojson.NewObject()
	doc.Set("guid", guid)
	doc.Set("kind", string(kind))
	doc.Set("type", typ)
	return doc
}

// SetWorkflowState records a state in the document.
func (a *Artifact) SetWorkflowState(id, state string) {
	wf := a.Doc.Object("workflows")
	if wf == nil {
		wf = ojson.NewObject()
		a.Doc.Set("workflows", wf)
	}
	wf.Set(id, state)
	if a.Workflows == nil {
		a.Workflows = map[string]string{}
	}
	a.Workflows[id] = state
}

// Now returns a fixed-width timestamp whose lexical order is chronological.
func Now() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z") }

// Summary is the projected metadata of an artifact (what listings show).
type Summary struct {
	GUID       string            `json:"guid"`
	Kind       Kind              `json:"kind"`
	Type       string            `json:"type"`
	Title      string            `json:"title,omitempty"`
	HID        string            `json:"hid,omitempty"`
	Folder     string            `json:"folder"`
	Path       string            `json:"path"` // repository file path
	Base       string            `json:"base,omitempty"`
	Source     string            `json:"source,omitempty"`
	Target     string            `json:"target,omitempty"`
	Subject    string            `json:"subject,omitempty"`
	Parent     string            `json:"parent,omitempty"`
	Author     string            `json:"author,omitempty"`
	Created    string            `json:"created,omitempty"`
	Workflows  map[string]string `json:"workflows,omitempty"`
	Fields     map[string]any    `json:"fields,omitempty"`
	ETag       string            `json:"etag,omitempty"`
	CreatedAt  *time.Time        `json:"createdAt,omitempty"`
	ModifiedAt *time.Time        `json:"modifiedAt,omitempty"`
	Links      int               `json:"links"`
	Comments   int               `json:"comments"`
}
