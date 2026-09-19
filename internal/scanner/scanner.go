// Package scanner implements the configurable repository scanner (design
// guide §10.4): a small set of markers (GUID files, configuration folders)
// decides which repository paths the Foundation cares about, and configured
// indexers decide what to do with them. Everything else in the repository
// is ignored, which keeps synchronization cheap and lets applications keep
// their own files next to Corestone's.
package scanner

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/thomdehoog/corestone/internal/model"
)

// ConfigPath is where the scanner configuration lives inside the repository.
const ConfigPath = model.MetadataDir + "/scanner.json"

// Config is the scanner configuration file.
type Config struct {
	GUIDFiles     []string `json:"guid_files"`
	ConfigFolders []string `json:"config_folders"`
	Indexers      []string `json:"indexers"`
}

// DefaultConfig is used when the repository has no scanner.json.
func DefaultConfig() Config {
	return Config{
		GUIDFiles:     []string{model.GUIDFile},
		ConfigFolders: []string{model.MetadataDir},
		Indexers:      []string{"foundation"},
	}
}

// ParseConfig decodes scanner.json, filling defaults for missing lists.
func ParseConfig(data []byte) (Config, error) {
	c := DefaultConfig()
	if len(data) == 0 {
		return c, nil
	}
	var raw Config
	if err := json.Unmarshal(data, &raw); err != nil {
		return c, fmt.Errorf("scanner.json: %w", err)
	}
	if len(raw.GUIDFiles) > 0 {
		c.GUIDFiles = raw.GUIDFiles
	}
	if len(raw.ConfigFolders) > 0 {
		c.ConfigFolders = raw.ConfigFolders
	}
	if len(raw.Indexers) > 0 {
		c.Indexers = raw.Indexers
	}
	for _, f := range c.GUIDFiles {
		if f == "" || strings.Contains(f, "/") {
			return c, fmt.Errorf("scanner.json: invalid guid file %q", f)
		}
	}
	for _, f := range c.ConfigFolders {
		if f == "" || strings.Contains(f, "/") {
			return c, fmt.Errorf("scanner.json: invalid config folder %q", f)
		}
	}
	return c, nil
}

// Category says what a repository path is.
type Category int

const (
	Ignore     Category = iota
	Artifact            // the GUID file of an entry or document
	Attachment          // another file inside a GUID directory
	ConfigFile          // a file inside a configuration folder
)

func (c Category) String() string {
	return [...]string{"ignore", "artifact", "attachment", "config"}[c]
}

// Well-known configuration categories handled by the foundation indexer.
const (
	ConfigSchemas   = "schemas"
	ConfigWorkflows = "workflows"
	ConfigLinks     = "links"
	ConfigComments  = "comments"
	ConfigScanner   = "scanner"
	ConfigOther     = "other"
)

// Match is the classification of one repository path.
type Match struct {
	Category   Category
	Path       string
	Folder     string // artifacts: folder containing the GUID dir; config: scope folder
	GUID       string // artifacts and attachments: the GUID directory name
	Name       string // attachments: path inside the GUID dir; config: file name without .json
	ConfigDir  string // config: which configured folder matched
	ConfigKind string // config: schemas | workflows | links | comments | scanner | other
	Indexer    string // which indexer accepted the path
}

// Indexer recognizes and processes a category of repository data.
type Indexer interface {
	Name() string
	// Accept reports whether the indexer wants to process this match.
	Accept(m Match) bool
}

// Foundation is the built-in indexer for entries, documents, links,
// comments, schemas and workflow definitions.
type Foundation struct{}

func (Foundation) Name() string { return "foundation" }

func (Foundation) Accept(m Match) bool {
	switch m.Category {
	case Artifact, Attachment:
		return true
	case ConfigFile:
		switch m.ConfigKind {
		case ConfigSchemas, ConfigWorkflows, ConfigLinks, ConfigComments, ConfigScanner:
			return true
		}
	}
	return false
}

// Registry maps indexer names to implementations. Applications register
// their own indexers here before opening a repository.
var Registry = map[string]Indexer{"foundation": Foundation{}}

// Scanner classifies paths using a configuration and its active indexers.
type Scanner struct {
	cfg      Config
	indexers []Indexer
	Unknown  []string // configured indexer names with no registration
}

// New builds a scanner for a configuration.
func New(cfg Config) *Scanner {
	s := &Scanner{cfg: cfg}
	for _, name := range cfg.Indexers {
		if ix, ok := Registry[name]; ok {
			s.indexers = append(s.indexers, ix)
		} else {
			s.Unknown = append(s.Unknown, name)
		}
	}
	return s
}

// Default returns a scanner with the default configuration.
func Default() *Scanner { return New(DefaultConfig()) }

// Config returns the active configuration.
func (s *Scanner) Config() Config { return s.cfg }

// Classify determines what a path is, independent of indexers.
func (s *Scanner) Classify(p string) Match {
	m := Match{Path: p}
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "//") {
		return m
	}
	segs := strings.Split(p, "/")
	for i, seg := range segs {
		if s.isConfigFolder(seg) {
			m.Category = ConfigFile
			m.Folder = strings.Join(segs[:i], "/")
			m.ConfigDir = seg
			rest := segs[i+1:]
			switch {
			case len(rest) == 1 && rest[0] == "scanner.json" && m.Folder == "":
				m.ConfigKind, m.Name = ConfigScanner, "scanner"
			case len(rest) == 2 && strings.HasSuffix(rest[1], ".json") && isKnownConfigKind(rest[0]):
				m.ConfigKind, m.Name = rest[0], strings.TrimSuffix(rest[1], ".json")
			default:
				m.ConfigKind, m.Name = ConfigOther, strings.Join(rest, "/")
			}
			return m
		}
		if model.IsGUID(seg) {
			m.GUID = seg
			m.Folder = strings.Join(segs[:i], "/")
			rest := segs[i+1:]
			if len(rest) == 1 && s.isGUIDFile(rest[0]) {
				m.Category = Artifact
				m.Name = rest[0]
			} else if len(rest) > 0 {
				m.Category = Attachment
				m.Name = strings.Join(rest, "/")
			}
			return m
		}
	}
	return m
}

// Match classifies a path and asks the indexers whether it is relevant.
// The second result is false for paths nobody cares about.
func (s *Scanner) Match(p string) (Match, bool) {
	m := s.Classify(p)
	if m.Category == Ignore {
		return m, false
	}
	for _, ix := range s.indexers {
		if ix.Accept(m) {
			m.Indexer = ix.Name()
			return m, true
		}
	}
	return m, false
}

func (s *Scanner) isConfigFolder(seg string) bool {
	for _, f := range s.cfg.ConfigFolders {
		if f == seg {
			return true
		}
	}
	return false
}

func (s *Scanner) isGUIDFile(name string) bool {
	for _, f := range s.cfg.GUIDFiles {
		if f == name {
			return true
		}
	}
	return false
}

func isKnownConfigKind(k string) bool {
	switch k {
	case ConfigSchemas, ConfigWorkflows, ConfigLinks, ConfigComments:
		return true
	}
	return false
}

// KindOf maps a config category to the artifact kind stored there.
func KindOf(configKind string) (model.Kind, bool) {
	switch configKind {
	case ConfigLinks:
		return model.KindLink, true
	case ConfigComments:
		return model.KindComment, true
	}
	return "", false
}
