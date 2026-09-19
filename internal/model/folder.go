package model

import (
	"path"
	"strings"
	"unicode"
)

const (
	maxFolderDepth   = 32
	maxSegmentBytes  = 255
	maxFolderBytes   = 1024
	pathspecMagicSep = ':'
)

// CleanFolder normalizes and validates a user-supplied folder path. The empty
// string is the repository root. Every folder path that reaches Git or the
// projection passes through here.
func CleanFolder(p string) (string, error) {
	p = strings.ReplaceAll(strings.TrimSpace(p), "\\", "/")
	p = strings.Trim(p, "/")
	if p == "" {
		return "", nil
	}
	if len(p) > maxFolderBytes {
		return "", Invalid("folder path longer than %d bytes", maxFolderBytes)
	}
	segs := strings.Split(p, "/")
	if len(segs) > maxFolderDepth {
		return "", Invalid("folder deeper than %d levels", maxFolderDepth)
	}
	for _, s := range segs {
		if err := ValidateSegment(s); err != nil {
			return "", err
		}
	}
	return strings.Join(segs, "/"), nil
}

// ValidateSegment checks a single folder name.
func ValidateSegment(s string) error {
	switch {
	case s == "", s == ".", s == "..":
		return Invalid("folder segment %q is not allowed", s)
	case len(s) > maxSegmentBytes:
		return Invalid("folder segment longer than %d bytes", maxSegmentBytes)
	case s == MetadataDir:
		return Invalid("folder segment %q is reserved for metadata", MetadataDir)
	case IsGUID(s):
		return Invalid("folder segment %q looks like an artifact GUID", s)
	case s[0] == pathspecMagicSep:
		return Invalid("folder segment %q must not start with ':'", s)
	case strings.ContainsAny(s, "/\\"):
		return Invalid("segment %q must not contain path separators", s)
	case strings.TrimSpace(s) != s:
		return Invalid("folder segment %q has leading or trailing whitespace", s)
	}
	for _, r := range s {
		if unicode.IsControl(r) || r == unicode.ReplacementChar {
			return Invalid("folder segment contains control or invalid characters")
		}
	}
	return nil
}

// ArtifactDir is the GUID directory of a folder-kind artifact.
func ArtifactDir(folder, guid string) string {
	if folder == "" {
		return guid
	}
	return folder + "/" + guid
}

// MetadataPath builds "<scope>/.corestone/<category>/<name>.json".
func MetadataPath(scope, category, name string) string {
	p := MetadataDir + "/" + category + "/" + name + ".json"
	if scope == "" {
		return p
	}
	return scope + "/" + p
}

// Ancestors lists a folder and all of its ancestors up to the root,
// nearest first: "a/b/c" -> ["a/b/c", "a/b", "a", ""].
func Ancestors(folder string) []string {
	var out []string
	for {
		out = append(out, folder)
		if folder == "" {
			return out
		}
		folder = path.Dir(folder)
		if folder == "." {
			folder = ""
		}
	}
}

// Lineage lists the root and every folder down to the given one, root first.
func Lineage(folder string) []string {
	a := Ancestors(folder)
	for i, j := 0, len(a)-1; i < j; i, j = i+1, j-1 {
		a[i], a[j] = a[j], a[i]
	}
	return a
}

// IsWithin reports whether folder equals or lies below prefix.
func IsWithin(folder, prefix string) bool {
	return prefix == "" || folder == prefix || strings.HasPrefix(folder, prefix+"/")
}
