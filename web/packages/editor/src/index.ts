// @corestone/editor: a rich-text editor that knows nothing about Corestone.
// Use it as <cs-richtext> (value property, "change" event) or through
// RichTextEditor directly. The stored form is described in ./model.ts.
import { RichTextEditor } from "./editor";
import type { DocNode, RichText } from "./model";
import type { DocumentHost, OutlineItem } from "./structure";
import type { ItemLinks } from "./links";
import type { EntryFiles } from "./files";
import type { Palette } from "@corestone/ui";

export { RichTextEditor, type EditorOptions } from "./editor";
export { type ItemLinks } from "./links";
export { type EntryFiles } from "./files";
export { documentFromStorage, documentText, documentTitle, documentToStorage, fileNames, fromStorage, isEntryNode, isSectionNode, isTable, isTocNode, newSectionId, plainText, renameFiles, toStorage,
  type DocNode, type EntryNode, type SectionNode, type TocNode, type Block, type Cell, type DiagramRun, type FormulaRun, type ImageRun, type Marks, type Paragraph, type RichText, type Run, type Table } from "./model";
export { DEFAULT_PALETTE, DEFAULT_STRIPES } from "./toolbar";
export type { Palette, StripePreset } from "@corestone/ui";
export { FONTS, SIZES, SIZE_MAX, SIZE_MIN } from "./schema";
export { numbering, type DocumentHost, type OutlineItem, type Placed } from "./structure";
export type { EntryTypeChoice } from "./toolbar";

/** <cs-richtext>: set .value (and optionally .palette, readonly) and listen for "change" (detail: the value). */
export class RichTextElement extends HTMLElement {
  static observedAttributes = ["readonly"];
  private editor?: RichTextEditor;
  private pending: RichText | null = null;
  palette?: Palette;
  /** Links to items of the host application; without it only web links are offered. */
  items?: ItemLinks;
  /** The entry's files, for images, file links and formulas; without it none is offered. */
  files?: EntryFiles;
  private drawio?: string;
  /** The address of the draw.io web app; without it no diagrams are offered. */
  get diagrams(): string | undefined { return this.drawio; }
  set diagrams(v: string | undefined) {
    this.drawio = v;
    this.editor?.refresh(); // the toolbar offers diagrams (or not)
  }

  get value(): RichText | null { return this.editor ? (this.editor.value as RichText) : this.pending; }
  set value(v: RichText | null) {
    this.pending = v;
    // the same value again (a host re-rendering) keeps the cursor and the undo history
    if (this.editor && !same(v, this.editor.value as RichText)) this.editor.value = v;
  }

  connectedCallback() {
    if (this.editor) return;
    this.editor = new RichTextEditor(this, {
      value: this.pending,
      palette: this.palette,
      readonly: this.hasAttribute("readonly"),
      items: () => this.items,
      files: () => this.files,
      diagrams: () => this.drawio,
      onChange: (value) => { this.pending = value as RichText; this.dispatchEvent(new CustomEvent("change", { detail: value, bubbles: true })); },
    });
  }

  attributeChangedCallback(name: string) {
    if (name === "readonly") this.editor?.setReadonly(this.hasAttribute("readonly"));
  }

  disconnectedCallback() { this.editor?.destroy(); this.editor = undefined; }

  override focus() { this.editor?.focus(); }
}

/** Whether two values are the same text: empty is empty, however it is written. */
function same(a: RichText | null | undefined, b: RichText | null | undefined): boolean {
  const norm = (v: RichText | null | undefined) => (v == null || (Array.isArray(v) && !v.length) ? "" : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** JSON with the keys of every object sorted, to compare stored values. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
}

/** <cs-document>: a document's editor. Set .host (entries), .docTitle, .value (the content) and
 *  optionally .items, .files, .diagrams, .palette, readonly; listen for "change" (detail: the
 *  content) and "outline" (detail: the sections). */
export class DocumentElement extends HTMLElement {
  static observedAttributes = ["readonly"];
  private editor?: RichTextEditor;
  private pending: DocNode[] = [];
  private pendingTitle = "";
  palette?: Palette;
  items?: ItemLinks;
  files?: EntryFiles;
  host?: DocumentHost;

  /** Whether the title is the editor's first line (set before it is shown); otherwise the host
   *  shows it, and the document starts with its introduction. */
  titleLine = false;
  /** The document's title, when it is the first line. ("title" is the tooltip attribute.) */
  get docTitle(): string { return this.editor ? this.editor.title : this.pendingTitle; }
  set docTitle(v: string) {
    this.pendingTitle = v ?? "";
    if (this.editor && this.editor.title !== this.pendingTitle) this.editor.setTitle(this.pendingTitle);
  }
  private drawio?: string;
  get diagrams(): string | undefined { return this.drawio; }
  set diagrams(v: string | undefined) { this.drawio = v; this.editor?.refresh(); }

  get value(): DocNode[] { return this.editor ? (this.editor.value as DocNode[]) : this.pending; }
  set value(v: DocNode[] | null) {
    if (v === this.pending) return; // the value it gave out itself (a host re-rendering)
    this.pending = v ?? [];
    // the same content again, however its keys are ordered, keeps the cursor and the undo history
    if (this.editor && canonical(this.pending) !== canonical(this.editor.value)) {
      this.editor.value = this.pending;
      this.outlineChanged();
    }
  }

  /** The sections, in order. */
  get outline(): OutlineItem[] { return this.editor?.outline() ?? []; }
  /** Puts the cursor into a section's heading and scrolls there. */
  revealSection(id: string) { return this.editor?.revealSection(id) ?? false; }
  /** Moves a section into a parent (null: the top level), before the parent's index-th section. */
  moveSection(id: string, parentId: string | null, index: number) { return this.editor?.moveSection(id, parentId, index) ?? false; }
  /** Shows placed entries and cross-references again (e.g. once their names are known). */
  refresh() { this.editor?.refresh(); }
  /** Puts the GUIDs a save gave new entries in place of their keys (the undo history stays). */
  renameEntries(names: Map<string, string>) { this.editor?.renameEntries(names); }
  /** The toolbar, taken out of the editor for the host to place in its own bar. */
  toolbar(): HTMLElement | undefined { return this.editor?.detachToolbar(); }

  connectedCallback() {
    if (this.editor) return;
    this.editor = new RichTextEditor(this, {
      value: this.pending,
      palette: this.palette,
      readonly: this.hasAttribute("readonly"),
      items: () => this.items,
      files: () => this.files,
      diagrams: () => this.drawio,
      document: () => this.host,
      title: this.titleLine ? this.pendingTitle : undefined,
      onChange: (value) => { this.pending = value as DocNode[]; this.pendingTitle = this.editor?.title ?? this.pendingTitle; this.dispatchEvent(new CustomEvent("change", { detail: value, bubbles: true })); },
      onOutline: () => this.outlineChanged(),
    });
    this.outlineChanged();
  }

  private outlineChanged() { this.dispatchEvent(new CustomEvent("outline", { detail: this.outline, bubbles: true })); }

  attributeChangedCallback(name: string) {
    if (name === "readonly") this.editor?.setReadonly(this.hasAttribute("readonly"));
  }

  disconnectedCallback() { this.editor?.destroy(); this.editor = undefined; }

  override focus() { this.editor?.focus(); }
}

if (!customElements.get("cs-richtext")) customElements.define("cs-richtext", RichTextElement);
if (!customElements.get("cs-document")) customElements.define("cs-document", DocumentElement);
