package model

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/thomdehoog/corestone/internal/ojson"
)

func TestGUID(t *testing.T) {
	g := NewGUID()
	if !IsGUID(g) || g != strings.ToLower(g) {
		t.Fatalf("bad guid %s", g)
	}
	if n, err := NormalizeGUID(strings.ToUpper(g)); err != nil || n != g {
		t.Fatal("normalize")
	}
	if _, err := NormalizeGUID("nope"); !errors.Is(err, ErrValidation) {
		t.Fatal("accepted garbage guid")
	}
}

func TestCleanFolder(t *testing.T) {
	good := map[string]string{"": "", "/a/b/": "a/b", "sp ace/ü": "sp ace/ü", "a\\b": "a/b"}
	for in, want := range good {
		got, err := CleanFolder(in)
		if err != nil || got != want {
			t.Errorf("CleanFolder(%q)=%q,%v want %q", in, got, err, want)
		}
	}
	bad := []string{"..", "a/../b", ".corestone", "a/.corestone/b", NewGUID(), "a/" + NewGUID(), ":magic", "a\x00b", "a\nb", "a/ x", strings.Repeat("a/", 40)}
	for _, in := range bad {
		if _, err := CleanFolder(in); err == nil {
			t.Errorf("CleanFolder(%q) accepted", in)
		}
	}
	if got := Ancestors("a/b/c"); strings.Join(got, "|") != "a/b/c|a/b|a|" {
		t.Fatalf("Ancestors %v", got)
	}
	if got := Lineage("a/b"); strings.Join(got, "|") != "|a|a/b" {
		t.Fatalf("Lineage %v", got)
	}
	if !IsWithin("a/b", "a") || IsWithin("ab", "a") || !IsWithin("x", "") {
		t.Fatal("IsWithin")
	}
	if MetadataPath("", "links", "g") != ".corestone/links/g.json" || MetadataPath("a", "schemas", "t") != "a/.corestone/schemas/t.json" {
		t.Fatal("MetadataPath")
	}
}

func mustSchema(t *testing.T, s string) *Schema {
	t.Helper()
	sc, err := ParseSchema([]byte(s))
	if err != nil {
		t.Fatalf("%s: %v", s, err)
	}
	return sc
}

func TestSchemaComposition(t *testing.T) {
	root := mustSchema(t, `{"type":"req","displayName":"Requirement","hid":{"prefix":"REQ"},
	  "fields":[{"id":"prio","name":"Priority","type":"enum","options":[{"value":"low"},{"value":"high"}]},
	            {"id":"owner","type":"text"}],"workflows":["dev"],"presentation":{"icon":"a","color":"red"},"x-custom":1}`)
	team := mustSchema(t, `{"type":"req","fields":[{"id":"prio","name":"Prio","type":"enum","options":[{"value":"p1"}]},
	  {"id":"cost","type":"currency","currency":"EUR"}],"workflows":["publish"],"presentation":{"icon":"b"}}`)
	idx := NewSchemaIndex([]ScopedSchema{{Scope: "", Schema: root}, {Scope: "teams/a", Schema: team}})

	eff := idx.Effective("req", "teams/a/sub")
	if eff == nil || eff.DisplayName != "Requirement" || eff.HID.Prefix != "REQ" {
		t.Fatalf("effective %+v", eff)
	}
	if ids := fieldIDs(eff); ids != "prio,owner,cost" {
		t.Fatalf("field order/merge: %s", ids)
	}
	if eff.Field("prio").Name != "Prio" || len(eff.Field("prio").Options) != 1 {
		t.Fatal("nearest field definition must replace completely")
	}
	if strings.Join(eff.Workflows, ",") != "dev,publish" {
		t.Fatalf("workflows %v", eff.Workflows)
	}
	if eff.Presentation["icon"] != "b" || eff.Presentation["color"] != "red" {
		t.Fatal("presentation merge")
	}
	if eff.Extra["x-custom"] == nil {
		t.Fatal("extra properties must pass through")
	}
	if len(eff.Sources) != 2 {
		t.Fatalf("sources %v", eff.Sources)
	}
	// Root scope sees only the root definition.
	if r := idx.Effective("req", ""); fieldIDs(r) != "prio,owner" {
		t.Fatal("root leaks subtree definitions")
	}
	// inheritance off severs everything above.
	sev := mustSchema(t, `{"type":"req","inheritance":"off","fields":[{"id":"only","type":"text"}]}`)
	idx2 := NewSchemaIndex([]ScopedSchema{{Scope: "", Schema: root}, {Scope: "iso", Schema: sev}, {Scope: "iso/deep", Schema: team}})
	e2 := idx2.Effective("req", "iso/deep/x")
	if fieldIDs(e2) != "only,prio,cost" || e2.HID != nil || len(e2.Sources) != 2 {
		t.Fatalf("severed: %s hid=%v sources=%v", fieldIDs(e2), e2.HID, e2.Sources)
	}
	if idx.Effective("nope", "") != nil {
		t.Fatal("unknown type must resolve to nil")
	}
	b, _ := json.Marshal(eff)
	if !strings.Contains(string(b), `"x-custom":1`) {
		t.Fatalf("marshal lost extras: %s", b)
	}
}

func fieldIDs(s *Schema) string {
	var ids []string
	for _, f := range s.Fields {
		ids = append(ids, f.ID)
	}
	return strings.Join(ids, ",")
}

func TestLinkSchemas(t *testing.T) {
	req := mustSchema(t, `{"type":"req"}`)
	tc := mustSchema(t, `{"type":"tc"}`)
	ver := mustSchema(t, `{"type":"verifies","kind":"link","sourceTypes":["tc"],"targetTypes":["req"],"cardinality":"many-to-one"}`)
	any_ := mustSchema(t, `{"type":"related","kind":"link"}`)
	idx := NewSchemaIndex([]ScopedSchema{{"", req}, {"", tc}, {"", ver}, {"", any_}})
	src, tgt := idx.LinkTypesFor("req", "x")
	if len(src) != 1 || src[0].Type != "related" || len(tgt) != 2 {
		t.Fatalf("link types for req: %d %d", len(src), len(tgt))
	}
	if _, err := ParseSchema([]byte(`{"type":"x","cardinality":"lots"}`)); err == nil {
		t.Fatal("bad cardinality accepted")
	}
	for _, bad := range []string{`{"type":""}`, `{"type":"a b"}`, `{"type":"x","kind":"blob"}`, `{"type":"x","fields":[{"id":"f","type":"nope"}]}`,
		`{"type":"x","fields":[{"id":"f","type":"text"},{"id":"f","type":"text"}]}`, `{"type":"x","hid":{"prefix":""}}`, `{"type":"x","fields":[{"id":"e","type":"enum"}]}`} {
		if _, err := ParseSchema([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}

func TestFieldValidation(t *testing.T) {
	num := func(s string) any { return ojson.Number(s) }
	cases := []struct {
		f  Field
		v  any
		ok bool
	}{
		{Field{ID: "b", Type: FieldBoolean}, true, true},
		{Field{ID: "b", Type: FieldBoolean}, "true", false},
		{Field{ID: "i", Type: FieldInteger}, num("42"), true},
		{Field{ID: "i", Type: FieldInteger}, num("4.2"), false},
		{Field{ID: "f", Type: FieldFloat}, num("4.2"), true},
		{Field{ID: "d", Type: FieldDate}, "2026-09-19", true},
		{Field{ID: "d", Type: FieldDate}, "19.09.2026", false},
		{Field{ID: "t", Type: FieldTime}, "13:45", true},
		{Field{ID: "dt", Type: FieldDateTime}, "2026-09-19T10:00:00Z", true},
		{Field{ID: "e", Type: FieldEnum, Options: []EnumOption{{Value: "a"}}}, "a", true},
		{Field{ID: "e", Type: FieldEnum, Options: []EnumOption{{Value: "a"}}}, "z", false},
		{Field{ID: "e", Type: FieldEnum, Options: []EnumOption{{Value: "a"}}, Extendable: true}, "z", true},
		{Field{ID: "e", Type: FieldEnum, Multiple: true, Options: []EnumOption{{Value: "a"}}}, []any{"a"}, true},
		{Field{ID: "e", Type: FieldEnum, Multiple: true, Options: []EnumOption{{Value: "a"}}}, "a", false},
		{Field{ID: "u", Type: FieldHyperlink}, "https://x.y", true},
		{Field{ID: "u", Type: FieldHyperlink}, "x.y", false},
		{Field{ID: "u", Type: FieldHyperlink}, "javascript:alert(1)", false},
		{Field{ID: "u", Type: FieldHyperlink}, "data:text/html,x", false},
		{Field{ID: "u", Type: FieldHyperlink}, "mailto:a@b.c", true},
		{Field{ID: "t", Type: FieldText}, "nul\x00", false},
		{Field{ID: "t", Type: FieldMultiline}, "tabs\tand\nnewlines are fine", true},
		{Field{ID: "r", Type: FieldReference}, NewGUID(), true},
		{Field{ID: "r", Type: FieldReference}, "REQ-1", false},
		{Field{ID: "rs", Type: FieldReferences}, []any{NewGUID()}, true},
		{Field{ID: "j", Type: FieldJSON}, ojson.NewObject(), true},
		{Field{ID: "n", Type: FieldText}, nil, true},
	}
	for i, c := range cases {
		err := c.f.ValidateValue(c.v)
		if (err == nil) != c.ok {
			t.Errorf("case %d (%s=%v): err=%v want ok=%v", i, c.f.Type, c.v, err, c.ok)
		}
	}
	g := NewGUID()
	if refs := (&Field{ID: "r", Type: FieldReferences}).ReferencedGUIDs([]any{g}); len(refs) != 1 || refs[0] != g {
		t.Fatal("ReferencedGUIDs")
	}
}

func TestWorkflow(t *testing.T) {
	w, err := ParseWorkflow([]byte(`{"id":"dev","initial":"open","states":["open",{"id":"review","name":"In review"},"done"],
	  "transitions":[{"id":"submit","from":"open","to":"review"},{"from":["review"],"to":"done"},{"id":"reset","from":"*","to":"open"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(w.Available("open")) != 2 || len(w.Available("done")) != 1 {
		t.Fatalf("available %v", w.Available("open"))
	}
	if _, ok := w.Find("open", "review"); !ok {
		t.Fatal("find by state")
	}
	if _, ok := w.Find("open", "submit"); !ok {
		t.Fatal("find by id")
	}
	if _, ok := w.Find("open", "done"); ok {
		t.Fatal("illegal transition allowed")
	}
	for _, bad := range []string{`{"id":"x","states":[]}`, `{"id":"x","initial":"z","states":["a"]}`, `{"id":"x","states":["a"],"transitions":[{"from":"a","to":"q"}]}`, `{"id":"x","states":["a","a"]}`} {
		if _, err := ParseWorkflow([]byte(bad)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	idx := NewWorkflowIndex(map[string][]*Workflow{"": {w}, "a": {{ID: "dev", Initial: "x", States: []State{{ID: "x"}}}}})
	if idx.Resolve("dev", "a/b").Initial != "x" || idx.Resolve("dev", "b").Initial != "open" || idx.Resolve("nope", "") != nil {
		t.Fatal("lexical workflow resolution")
	}
	if idx.Resolve("dev", "a").Scope != "a" {
		t.Fatal("scope not recorded")
	}
}

func TestArtifactAndOverlay(t *testing.T) {
	g1, g2, g3 := NewGUID(), NewGUID(), NewGUID()
	mk := func(guid, base string, fields string) *Artifact {
		doc := NewDoc(KindEntry, guid, "req")
		doc.Set("title", "t")
		if base != "" {
			doc.Set("base", base)
		}
		f, _ := ojson.ParseObject([]byte(fields))
		doc.Set("fields", f)
		a, err := ArtifactFromDoc(doc, KindEntry)
		if err != nil {
			t.Fatal(err)
		}
		if err := a.Validate(); err != nil {
			t.Fatal(err)
		}
		return a
	}
	all := map[string]*Artifact{
		g1: mk(g1, "", `{"a":1,"b":"base"}`),
		g2: mk(g2, g1, `{"b":"mid","c":true}`),
		g3: mk(g3, g2, `{"c":false}`),
	}
	lookup := func(guid string) (*Artifact, error) {
		if a, ok := all[guid]; ok {
			return a, nil
		}
		return nil, ErrNotFound
	}
	ov, err := ResolveOverlay(all[g3], lookup)
	if err != nil {
		t.Fatal(err)
	}
	if len(ov.Chain) != 3 || ov.Chain[0].GUID != g1 || ov.Chain[2].GUID != g3 {
		t.Fatalf("chain %+v", ov.Chain)
	}
	out, _ := ov.Fields.MarshalJSON()
	if string(out) != `{"a":1,"b":"mid","c":false}` {
		t.Fatalf("fields %s", out)
	}
	if ov.Origin["a"] != g1 || ov.Origin["b"] != g2 || ov.Origin["c"] != g3 {
		t.Fatalf("origin %v", ov.Origin)
	}
	// cycle
	all[g1].Doc.Set("base", g3)
	all[g1], _ = ArtifactFromDoc(all[g1].Doc, KindEntry)
	if _, err := ResolveOverlay(all[g3], lookup); !errors.Is(err, ErrValidation) {
		t.Fatalf("cycle not detected: %v", err)
	}
	// dangling
	all[g1].Doc.Set("base", NewGUID())
	all[g1], _ = ArtifactFromDoc(all[g1].Doc, KindEntry)
	if _, err := ResolveOverlay(all[g3], lookup); !errors.Is(err, ErrNotFound) {
		t.Fatalf("dangling base: %v", err)
	}
	// self base rejected
	self := NewDoc(KindEntry, g1, "req")
	self.Set("title", "x")
	self.Set("base", g1)
	a, _ := ArtifactFromDoc(self, KindEntry)
	if err := a.Validate(); err == nil {
		t.Fatal("self base accepted")
	}
	if _, err := ParseArtifact([]byte(`{"guid":"nope"}`), KindEntry); err == nil {
		t.Fatal("bad guid accepted")
	}
	// workflow state round-trips through the document
	a2 := all[g2]
	a2.SetWorkflowState("dev", "open")
	if a2.Doc.Object("workflows").String("dev") != "open" || a2.Workflows["dev"] != "open" {
		t.Fatal("SetWorkflowState")
	}
}

func TestContent(t *testing.T) {
	g := NewGUID()
	blocks, _ := ojson.Parse([]byte(`[{"type":"section","title":"S","children":[{"type":"paragraph","text":"hello"},{"type":"entry","guid":"` + g + `"},{"type":"list","items":[{"type":"paragraph","text":"item"}]}]}]`))
	if err := ValidateContent(blocks.([]any)); err != nil {
		t.Fatal(err)
	}
	if refs := ContentRefs(blocks.([]any)); len(refs) != 1 || refs[0] != g {
		t.Fatal("refs")
	}
	if txt := ContentText(blocks.([]any)); !strings.Contains(txt, "hello") || !strings.Contains(txt, "item") || !strings.Contains(txt, "S") {
		t.Fatalf("text %q", txt)
	}
	for _, bad := range []string{`[{"type":"blob"}]`, `[{"type":"entry","guid":"x"}]`, `[1]`, `[{"type":"paragraph","text":5}]`, `[{"type":"image"}]`} {
		v, _ := ojson.Parse([]byte(bad))
		if err := ValidateContent(v.([]any)); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	deep := "[]"
	for i := 0; i < 20; i++ {
		deep = `[{"type":"section","children":` + deep + `}]`
	}
	v, _ := ojson.Parse([]byte(deep))
	if err := ValidateContent(v.([]any)); err == nil {
		t.Error("accepted over-deep nesting")
	}
}
