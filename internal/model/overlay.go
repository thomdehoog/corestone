package model

import (
	"github.com/thomdehoog/corestone/internal/ojson"
)

// MaxOverlayDepth bounds base chains.
const MaxOverlayDepth = 32

// OverlayLevel is one entry in a resolved base chain, root base first.
type OverlayLevel struct {
	GUID   string   `json:"guid"`
	Title  string   `json:"title,omitempty"`
	HID    string   `json:"hid,omitempty"`
	Fields []string `json:"fields"` // fields this level defines explicitly
}

// Overlay is the analysis of an entry's composition (design guide §2.3.1).
type Overlay struct {
	Chain  []OverlayLevel    `json:"chain"`  // root base first, the entry itself last
	Fields *ojson.Object     `json:"fields"` // effective values
	Origin map[string]string `json:"origin"` // field -> GUID that provides the value
}

// ResolveOverlay composes the effective fields of an entry from its base
// chain. lookup fetches an entry by GUID; it returns ErrNotFound for a
// dangling base. Cycles and over-deep chains are validation errors.
func ResolveOverlay(entry *Artifact, lookup func(guid string) (*Artifact, error)) (*Overlay, error) {
	chain := []*Artifact{entry}
	seen := map[string]bool{entry.GUID: true}
	cur := entry
	for cur.Base != "" {
		if seen[cur.Base] {
			return nil, Invalid("overlay cycle through %s", cur.Base)
		}
		if len(chain) >= MaxOverlayDepth {
			return nil, Invalid("overlay chain deeper than %d", MaxOverlayDepth)
		}
		base, err := lookup(cur.Base)
		if err != nil {
			return nil, err
		}
		if base.Kind != KindEntry {
			return nil, Invalid("base %s is not an entry", cur.Base)
		}
		seen[base.GUID] = true
		chain = append(chain, base)
		cur = base
	}
	ov := &Overlay{Fields: ojson.NewObject(), Origin: map[string]string{}}
	for i := len(chain) - 1; i >= 0; i-- {
		a := chain[i]
		lvl := OverlayLevel{GUID: a.GUID, Title: a.Title, HID: a.HID, Fields: []string{}}
		if a.Fields != nil {
			for _, k := range a.Fields.Keys() {
				v, _ := a.Fields.Get(k)
				lvl.Fields = append(lvl.Fields, k)
				ov.Fields.Set(k, ojson.Clone(v))
				ov.Origin[k] = a.GUID
			}
		}
		ov.Chain = append(ov.Chain, lvl)
	}
	return ov, nil
}
