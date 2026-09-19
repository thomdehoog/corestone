package scanner

import (
	"testing"

	"github.com/thomdehoog/corestone/internal/model"
)

func TestClassify(t *testing.T) {
	s := Default()
	g := model.NewGUID()
	cases := []struct {
		path string
		cat  Category
		kind string
		rel  bool
	}{
		{g + "/.corestone.json", Artifact, "", true},
		{"a/b/" + g + "/.corestone.json", Artifact, "", true},
		{"a/" + g + "/spec.pdf", Attachment, "", true},
		{"a/" + g + "/sub/x.png", Attachment, "", true},
		{".corestone/schemas/req.json", ConfigFile, ConfigSchemas, true},
		{"a/.corestone/workflows/dev.json", ConfigFile, ConfigWorkflows, true},
		{"a/.corestone/links/" + g + ".json", ConfigFile, ConfigLinks, true},
		{"a/.corestone/comments/" + g + ".json", ConfigFile, ConfigComments, true},
		{".corestone/scanner.json", ConfigFile, ConfigScanner, true},
		{"a/.corestone/scanner.json", ConfigFile, ConfigOther, false},
		{".corestone/ext/thing.json", ConfigFile, ConfigOther, false},
		{"README.md", Ignore, "", false},
		{"a/b/notes.txt", Ignore, "", false},
		{g, Ignore, "", false},
		{"", Ignore, "", false},
		{"/" + g + "/.corestone.json", Ignore, "", false},
	}
	for _, c := range cases {
		m, rel := s.Match(c.path)
		if m.Category != c.cat || m.ConfigKind != c.kind || rel != c.rel {
			t.Errorf("%q: got %v/%q/%v want %v/%q/%v", c.path, m.Category, m.ConfigKind, rel, c.cat, c.kind, c.rel)
		}
	}
	m := s.Classify("a/b/" + g + "/.corestone.json")
	if m.Folder != "a/b" || m.GUID != g {
		t.Fatalf("%+v", m)
	}
	m = s.Classify("x/.corestone/links/" + g + ".json")
	if m.Folder != "x" || m.Name != g {
		t.Fatalf("%+v", m)
	}
	// Config folder wins over a GUID that appears later, and vice versa.
	if m := s.Classify(".corestone/" + g + "/.corestone.json"); m.Category != ConfigFile || m.ConfigKind != ConfigOther {
		t.Fatalf("%+v", m)
	}
	if m := s.Classify(g + "/.corestone/schemas/x.json"); m.Category != Attachment {
		t.Fatalf("%+v", m)
	}
}

func TestConfig(t *testing.T) {
	c, err := ParseConfig([]byte(`{"guid_files":[".corestone.json","artifact.json"],"config_folders":[".corestone",".meta"],"indexers":["foundation","ext"]}`))
	if err != nil {
		t.Fatal(err)
	}
	s := New(c)
	if len(s.Unknown) != 1 || s.Unknown[0] != "ext" {
		t.Fatalf("unknown %v", s.Unknown)
	}
	g := model.NewGUID()
	if m, ok := s.Match("a/" + g + "/artifact.json"); !ok || m.Category != Artifact {
		t.Fatal("custom guid file")
	}
	if m, ok := s.Match("a/.meta/schemas/x.json"); !ok || m.ConfigDir != ".meta" {
		t.Fatal("custom config folder")
	}
	if _, err := ParseConfig([]byte(`{"guid_files":["a/b"]}`)); err == nil {
		t.Fatal("accepted slash in guid file")
	}
	if _, err := ParseConfig([]byte(`nope`)); err == nil {
		t.Fatal("accepted garbage")
	}
	d, _ := ParseConfig(nil)
	if d.Indexers[0] != "foundation" {
		t.Fatal("defaults")
	}
}

func FuzzClassify(f *testing.F) {
	f.Add("a/.corestone/links/x.json")
	f.Add(model.NewGUID() + "/.corestone.json")
	f.Fuzz(func(t *testing.T, p string) {
		s := Default()
		m := s.Classify(p)
		switch m.Category {
		case Artifact, Attachment:
			if !model.IsGUID(m.GUID) {
				t.Fatalf("artifact match without GUID for %q", p)
			}
		case ConfigFile:
			if m.ConfigDir == "" {
				t.Fatalf("config match without dir for %q", p)
			}
		}
	})
}
