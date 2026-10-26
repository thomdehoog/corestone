package projection

import (
	"slices"
	"testing"
)

func TestHistoryGUIDs(t *testing.T) {
	const a = "0b6f3f0e-6d3c-4b5e-9a71-2f4c1d2e3a4b"
	const b = "7c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e"
	cases := map[string][]string{
		"specs/" + a + "/.corestone.json":                  {a},
		a + "/.corestone.json":                             {a},
		"specs/" + a + "/files/notes.txt":                  {a},
		"specs/" + a + "/" + b + "/.corestone.json":        {a, b},
		"specs/.corestone/links/" + a + ".json":            {a},
		".corestone/comments/" + a + ".json":               {a},
		"specs/.corestone/config/entries/types.json":       nil,
		"specs/" + a + ".json":                             nil, // not a GUID directory
		"specs/.corestone/other/" + a + ".json":            nil,
		"specs/0B6F3F0E-6D3C-4B5E-9A71-2F4C1D2E3A4B/x.txt": nil, // GUIDs are stored lowercase
	}
	for path, want := range cases {
		if got := HistoryGUIDs(path); !slices.Equal(got, want) {
			t.Errorf("HistoryGUIDs(%q) = %v, want %v", path, got, want)
		}
	}
}
