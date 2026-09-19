package model

import (
	"github.com/thomdehoog/corestone/internal/ojson"
)

// Document content is a tree of blocks (design guide §2.3.2): sections
// carry a title and children; paragraphs carry text; entry blocks reference
// reusable entries by GUID; images/media reference attachments or URLs.
const (
	BlockSection   = "section"
	BlockParagraph = "paragraph"
	BlockEntry     = "entry"
	BlockImage     = "image"
	BlockList      = "list"
	BlockCode      = "code"
)

const (
	maxBlockDepth = 16
	maxBlocks     = 20000
)

// ValidateContent checks a document's block tree.
func ValidateContent(blocks []any) error {
	n := 0
	return validateBlocks(blocks, 0, &n)
}

func validateBlocks(blocks []any, depth int, count *int) error {
	if depth > maxBlockDepth {
		return Invalid("document nesting deeper than %d", maxBlockDepth)
	}
	for _, raw := range blocks {
		*count++
		if *count > maxBlocks {
			return Invalid("document has more than %d blocks", maxBlocks)
		}
		b, ok := raw.(*ojson.Object)
		if !ok {
			return Invalid("document block must be an object")
		}
		switch b.String("type") {
		case BlockSection:
			if err := validateBlocks(b.Array("children"), depth+1, count); err != nil {
				return err
			}
		case BlockParagraph, BlockCode:
			if v, ok := b.Get("text"); ok {
				if _, isStr := v.(string); !isStr {
					return Invalid("block text must be a string")
				}
			}
		case BlockEntry:
			if !IsGUID(b.String("guid")) {
				return Invalid("entry block needs a GUID")
			}
		case BlockImage:
			if b.String("src") == "" {
				return Invalid("image block needs a src")
			}
		case BlockList:
			if err := validateBlocks(b.Array("items"), depth+1, count); err != nil {
				return err
			}
		default:
			return Invalid("unknown block type %q", b.String("type"))
		}
	}
	return nil
}

// ContentRefs collects the GUIDs of entries referenced by a document.
func ContentRefs(blocks []any) []string {
	var out []string
	var walk func([]any)
	walk = func(bs []any) {
		for _, raw := range bs {
			b, ok := raw.(*ojson.Object)
			if !ok {
				continue
			}
			switch b.String("type") {
			case BlockEntry:
				out = append(out, b.String("guid"))
			case BlockSection:
				walk(b.Array("children"))
			case BlockList:
				walk(b.Array("items"))
			}
		}
	}
	walk(blocks)
	return out
}

// ContentText extracts the readable text of a document for search.
func ContentText(blocks []any) string {
	var buf []byte
	var walk func([]any)
	walk = func(bs []any) {
		for _, raw := range bs {
			b, ok := raw.(*ojson.Object)
			if !ok {
				continue
			}
			for _, k := range []string{"title", "text", "alt", "caption"} {
				if s := b.String(k); s != "" {
					buf = append(buf, s...)
					buf = append(buf, ' ')
				}
			}
			walk(b.Array("children"))
			walk(b.Array("items"))
		}
	}
	walk(blocks)
	return string(buf)
}
