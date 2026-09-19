package model

import (
	"strings"
	"testing"
)

// FuzzCleanFolder asserts the safety envelope of every accepted folder path.
func FuzzCleanFolder(f *testing.F) {
	f.Add("a/b")
	f.Add(":x")
	f.Add("../x")
	f.Add("a/.corestone/b")
	f.Fuzz(func(t *testing.T, p string) {
		out, err := CleanFolder(p)
		if err != nil {
			return
		}
		if out == "" {
			return
		}
		for _, seg := range strings.Split(out, "/") {
			if seg == "" || seg == "." || seg == ".." || seg == MetadataDir || IsGUID(seg) || seg[0] == ':' {
				t.Fatalf("accepted dangerous segment %q in %q", seg, p)
			}
		}
		if strings.ContainsAny(out, "\x00\n\r\\") || strings.HasPrefix(out, "/") || strings.HasSuffix(out, "/") {
			t.Fatalf("accepted %q -> %q", p, out)
		}
		again, err := CleanFolder(out)
		if err != nil || again != out {
			t.Fatalf("not idempotent: %q -> %q -> %q (%v)", p, out, again, err)
		}
	})
}
