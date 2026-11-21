import { Fragment } from "prosemirror-model";
import { NodeSelection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { openMenu, type MenuItem } from "./menu";
import { schema } from "./schema";
import { fileNames, toStorage } from "./model";
import { entryToText, insertXref, placeEntries, placedEntries, replaceWithEntry, selectedText, setTocDepth, structureKey, xrefText, type DocumentHost } from "./structure";
import { el, Overlay } from "@corestone/ui";

// The document's own panels: the menus of a placed entry and of a table of contents, and the
// cross-reference picker.

export class DocumentUI {
  private readonly menu: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly overlay: Overlay;

  constructor(private readonly view: () => EditorView, root: HTMLElement, private readonly host: () => DocumentHost | undefined,
    private readonly notice: (msg: string) => void) {
    this.overlay = new Overlay({ root, onEscape: () => this.view().focus() });
    this.menu = this.overlay.panel("ui-pop ui-menu cs-menu cs-placementmenu", "menu", "Entry");
    this.picker = this.overlay.panel("cs-xrefpop", "dialog", "Cross-reference");
  }

  /** Lets the host pick entries and places them at the cursor, in the order picked. */
  async insertEntry() {
    const h = this.host();
    if (!h) return;
    const guids = await h.pickEntries(placedEntries(this.view().state.doc));
    if (!guids.length) return;
    const v = this.view();
    if (!placeEntries(guids)(v.state, v.dispatch)) this.notice(guids.length === 1 ? "The entry is in this document already; an entry is placed once per document."
      : "These entries are in this document already; an entry is placed once per document.");
    v.focus();
  }

  /** Makes a new entry of the selected text, held until the document is saved: with two blocks
   *  or more, the first paragraph is the title and the rest its text; a single block is the
   *  text, and its start the title (to the first word end after 40 characters). The entry
   *  takes the text's place. */
  async convert(type: string) {
    const h = this.host();
    if (!h?.convertToEntry) return;
    const sel = selectedText(this.view().state);
    if (typeof sel === "string") { this.notice(sel); return; }
    const [first, ...rest] = sel.nodes;
    const titled = sel.nodes.length > 1 && first.type === schema.nodes.paragraph && !!first.textContent.trim();
    const body = titled ? rest : sel.nodes;
    const text = body.length ? toStorage(schema.node("doc", null, body)) : "";
    const flat = (n: { textContent: string }) => n.textContent.replace(/\s+/g, " ").trim();
    const title = titled ? flat(first) : shortTitle(sel.nodes.map(flat).join(" "));
    const guid = await h.convertToEntry({ type, title, text, files: fileNames(text) });
    if (!guid) return;
    const v = this.view();
    // the text is replaced where it is, if it is still there unchanged; otherwise the entry is placed at the cursor
    const same = sel.to <= v.state.doc.content.size && v.state.doc.slice(sel.from, sel.to).content.eq(Fragment.from(sel.nodes));
    if (same) replaceWithEntry(sel.from, sel.to, guid)(v.state, v.dispatch);
    else if (!placeEntries([guid])(v.state, v.dispatch)) this.notice("The entry is made, but the text changed meanwhile; insert it with Insert entries.");
    v.focus();
  }

  /** Puts a placed entry's text in its place (the entry stays in the repository). */
  async unmark(guid?: string) {
    const h = this.host();
    if (!h?.entryAsText) return;
    const sel = this.view().state.selection;
    guid ??= sel instanceof NodeSelection && sel.node.type === schema.nodes.placement ? sel.node.attrs.guid as string : undefined;
    if (!guid) { this.notice("Select a placed entry first."); return; }
    const r = await h.entryAsText(guid);
    if ("error" in r) { this.notice(r.error); return; }
    const v = this.view();
    if (!entryToText(guid, r.text)(v.state, v.dispatch)) this.notice("The entry is not in the document any more.");
    v.focus();
  }

  /** The menu of the selected placed entry. */
  openMenu(at: { x: number; y: number }) {
    const view = this.view();
    const sel = view.state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type !== schema.nodes.placement) return;
    const guid = sel.node.attrs.guid as string;
    const pos = sel.from;
    const items: MenuItem[] = [
      { label: "Open", run: () => this.host()?.openEntry(guid, false) },
      ...(this.host()?.entryAsText ? [{ label: "Turn into text", run: () => void this.unmark(guid) }] : []),
      { label: "Remove from document", danger: true, cmd: (state, dispatch) => {
        const n = state.doc.nodeAt(pos);
        if (n?.type !== schema.nodes.placement) return false;
        dispatch?.(state.tr.delete(pos, pos + n.nodeSize).scrollIntoView());
        return true;
      } },
    ];
    this.showMenu("Entry", items, at);
  }

  /** The menu of the selected table of contents: its levels, and removing it. */
  openTocMenu(at: { x: number; y: number }) {
    const sel = this.view().state.selection;
    if (!(sel instanceof NodeSelection) || sel.node.type !== schema.nodes.toc) return;
    const pos = sel.from;
    const depth = (state: EditorState) => (state.doc.nodeAt(pos)?.attrs.depth as number | null | undefined) ?? null;
    const level = (d: number | null): MenuItem => ({ label: d === null ? "All levels" : d === 1 ? "1 level" : `${d} levels`,
      cmd: setTocDepth(pos, d), check: (state) => depth(state) === d });
    this.showMenu("Table of contents", [
      { label: "Levels", sub: [null, 1, 2, 3, 4, 5].map(level) },
      { label: "Remove", danger: true, cmd: (state, dispatch) => {
        const n = state.doc.nodeAt(pos);
        if (n?.type !== schema.nodes.toc) return false;
        dispatch?.(state.tr.delete(pos, pos + n.nodeSize).scrollIntoView());
        return true;
      } },
    ], at);
  }

  private showMenu(label: string, items: MenuItem[], at: { x: number; y: number }) {
    this.menu.setAttribute("aria-label", label);
    openMenu(this.overlay, this.menu, items, this.view, at, (v, it) => {
      if (it.cmd) it.cmd(v.state, v.dispatch);
      else it.run?.();
      v.focus();
    });
  }

  /** The cross-reference picker: the sections and the entries of this document. */
  openXref(at?: { x: number; y: number }) {
    const view = this.view();
    const h = this.host();
    const nums = structureKey.getState(view.state);
    const own = h?.guid;
    const choices: { ref: string; text: string }[] = [];
    for (const s of nums?.sections ?? []) {
      if (!own) break; // a section is referenced through its document
      choices.push({ ref: `${own}#${s.id}`, text: `${s.number} ${s.title}`.trim() });
    }
    for (const [guid] of nums?.entries ?? []) choices.push({ ref: guid, text: xrefText(view.state, guid, "", h).text });
    const head = el("div", "head");
    head.textContent = "Cross-reference";
    const filter = el("input", "filter") as HTMLInputElement;
    filter.placeholder = "Filter sections and entries";
    filter.setAttribute("aria-label", "Filter");
    const list = el("div", "list");
    list.setAttribute("role", "listbox");
    const show = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = choices.filter((c) => !q || c.text.toLowerCase().includes(q));
      list.replaceChildren(...shown.map((c) => {
        const b = el("button", "row") as HTMLButtonElement;
        b.type = "button";
        b.setAttribute("role", "option");
        b.textContent = c.text;
        b.addEventListener("click", () => {
          this.close();
          const v = this.view();
          insertXref(c.ref, c.text)(v.state, v.dispatch);
          v.focus();
        });
        return b;
      }));
      if (!shown.length) {
        const none = el("div", "none");
        none.textContent = choices.length ? "Nothing matches." : "This document has no sections or entries yet.";
        list.append(none);
      }
    };
    filter.addEventListener("input", show);
    filter.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); (list.querySelector("button") as HTMLElement | null)?.click(); }
      if (e.key === "ArrowDown") { e.preventDefault(); (list.querySelector("button") as HTMLElement | null)?.focus(); }
    });
    show();
    this.picker.replaceChildren(head, filter, list);
    const c = view.coordsAtPos(view.state.selection.head);
    this.overlay.open(this.picker, at ?? { x: c.left, y: c.bottom + 4 });
    filter.focus();
  }

  close() { this.overlay.close(); }

  destroy() { this.close(); }
}


/** The start of a text as a title: up to the end of the word that reaches 40 characters. */
export function shortTitle(text: string, min = 40): string {
  const t = text.trim();
  if (t.length <= min) return t;
  const end = t.slice(min).search(/\s/);
  return end < 0 ? t : t.slice(0, min + end);
}
