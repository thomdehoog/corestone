package model

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// Kind is one of the four native artifact classes.
type Kind string

const (
	KindEntry    Kind = "entry"
	KindDocument Kind = "document"
	KindLink     Kind = "link"
	KindComment  Kind = "comment"
)

// Kinds lists all native kinds.
var Kinds = []Kind{KindEntry, KindDocument, KindLink, KindComment}

// ParseKind validates a kind string.
func ParseKind(s string) (Kind, error) {
	for _, k := range Kinds {
		if string(k) == s {
			return k, nil
		}
	}
	return "", Invalid("unknown artifact kind %q", s)
}

// IsFolderKind reports whether artifacts of this kind live in GUID
// directories (entries, documents) rather than in .corestone metadata.
func (k Kind) IsFolderKind() bool { return k == KindEntry || k == KindDocument }

// MetadataDir is the name of the hidden configuration/metadata directory.
const MetadataDir = ".corestone"

// GUIDFile is the default marker file carrying an artifact's GUID.
const GUIDFile = ".corestone.json"

var guidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// NewGUID returns a fresh random (version 4) UUID in canonical lowercase form.
func NewGUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// IsGUID reports whether s has the GUID shape the scanner recognizes.
func IsGUID(s string) bool { return guidRe.MatchString(s) }

// NormalizeGUID lowercases and validates a GUID supplied by a client.
func NormalizeGUID(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if !IsGUID(s) {
		return "", Invalid("invalid GUID %q", s)
	}
	return s, nil
}

// HID rules: a short, printable, single-token identifier such as REQ-42.
const maxHIDLen = 64

// ValidateHID checks a human-readable identifier.
func ValidateHID(hid string) error {
	if hid == "" {
		return Invalid("HID must not be empty")
	}
	if len(hid) > maxHIDLen {
		return Invalid("HID longer than %d bytes", maxHIDLen)
	}
	for _, r := range hid {
		if unicode.IsSpace(r) || unicode.IsControl(r) || r == '/' || r == '\\' {
			return Invalid("HID %q contains whitespace or separators", hid)
		}
	}
	return nil
}

// ValidateTypeID checks an artifact type / workflow / link type identifier.
// Identifiers double as file names below .corestone, so they are restricted.
func ValidateTypeID(id string) error {
	if id == "" || len(id) > 64 {
		return Invalid("identifier %q must be 1-64 characters", id)
	}
	for i, r := range id {
		ok := r == '_' || r == '-' || r == '.' || unicode.IsLetter(r) || unicode.IsDigit(r)
		if !ok || (i == 0 && r == '.') {
			return Invalid("identifier %q may only contain letters, digits, '_', '-' and '.'", id)
		}
	}
	return nil
}
