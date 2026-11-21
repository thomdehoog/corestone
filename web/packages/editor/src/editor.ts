import { baseKeymap, chainCommands } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { splitListItem } from "prosemirror-schema-list";
import { DOMSerializer } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { clearFormatting, indent, keepAlign, outdent, setAlign, toggleFlag } from "./commands";
import { documentFromStorage, documentTitle, documentToStorage, fromStorage, toStorage, type DocNode, type RichText } from "./model";
import { DocumentUI } from "./docui";
import { CodeView, codeAround, codeAt, codeKeys, codeMenu, codeNumbers, copyCode, toggleCodeKey } from "./code";
import { popupMenu } from "./menu";
import {
  PlacementView, TocView, XrefView, backspaceStructure, insertToc, deleteStructure, demoteSection, makeHeading, makeNormal, moveSection, promoteSection, revealSection,
  renameEntries, splitHeading, structureKey, structurePlugin, synced, titleTab, type DocumentHost, type OutlineItem,
} from "./structure";
import { columnResizing, fixTables, tableEditing } from "prosemirror-tables";
import { FileUI, ImageView, addFiles, imageImporter, insertImage, isPicture, type EntryFiles } from "./files";
import { DiagramUI, selectedDiagram } from "./diagrams";
import { FormulaUI, FormulaView, formulaPictures, selectedFormula } from "./formulas";
import { LinkUI, openLink, type ItemLinks } from "./links";
import { StyledTableView, TableUI, flattenNestedTables, nextCell, prevCell, tableAt, tableEdges } from "./tables";
import { safeHref, schema } from "./schema";
import { DEFAULT_PALETTE, Toolbar } from "./toolbar";
import type { Palette } from "@corestone/ui";

export interface EditorOptions {
  /** The stored value: plain text or paragraphs; in a document, its content. */
  value?: RichText | DocNode[] | null;
  palette?: Palette;
  readonly?: boolean;
  /** Called after every change with the stored form. */
  onChange?: (value: RichText | DocNode[]) => void;
  /** Makes the editor a document's (sections, placed entries, numbers): what the host does
   *  for it. Fixed when the editor is made. */
  document?: () => DocumentHost | undefined;
  /** In a document: its title, shown as the first line of the editor; without it the document
   *  starts with its introduction (the host shows the title elsewhere). */
  title?: string;
  /** In a document: called with the sections whenever they change. */
  onOutline?: (sections: OutlineItem[]) => void;
  /** Links to items of the host application (asked each time, so the host may set it later). */
  items?: () => ItemLinks | undefined;
  /** The entry's files, for images and file links (asked each time, like items). */
  files?: () => EntryFiles | undefined;
  /** The address of the draw.io web app, for diagrams (asked each time; absent: no diagrams). */
  diagrams?: () => string | undefined;
}


/** A rich-text editor with its toolbar, in a host element. */
export class RichTextEditor {
  readonly view: EditorView;
  private readonly toolbar: Toolbar;
  private readonly root: HTMLElement;
  private readonly: boolean;
  private readonly links: LinkUI;
  private readonly tables: TableUI;
  private readonly files: FileUI;
  private readonly formulas: FormulaUI;
  private readonly diagrams: DiagramUI;
  private readonly doc?: DocumentUI;

  constructor(host: HTMLElement, private readonly opts: EditorOptions = {}) {
    const items = () => opts.items?.();
    const files = () => opts.files?.();
    this.readonly = !!opts.readonly;
    this.root = document.createElement("div");
    this.root.className = "cs-editor";
    this.root.classList.toggle("readonly", this.readonly);
    // the toolbar's own inputs are internal: their change events are not the editor's
    this.root.addEventListener("change", (e) => e.stopPropagation());
    this.toolbar = new Toolbar({ state: () => this.view.state, run: (cmd) => this.run(cmd), link: () => this.links.edit(), files: () => !!files(),
      image: (at) => this.files.pick({ images: true, at, chosen: (name) => this.run(insertImage(name)) }), table: (at) => this.tables.openGrid(at),
      formula: (at) => this.formulas.edit(at),
      diagrams: () => !!files() && !!opts.diagrams?.(), diagram: () => { void this.diagrams.edit(); },
      structure: opts.document ? { entry: () => { void this.doc?.insertEntry(); }, xref: (at) => this.doc?.openXref(at),
        toc: () => { this.run(insertToc); },
        // (offered when the host can make entries and give their text)
        ...(opts.document?.()?.convertToEntry && opts.document?.()?.entryAsText && opts.document?.()?.entryTypes
          ? { convert: (type: string) => { void this.doc?.convert(type); }, unmark: () => { void this.doc?.unmark(); },
            entryTypes: () => opts.document?.()?.entryTypes?.() ?? { remember: "", types: [] } } : {}) } : undefined },
      opts.palette ?? DEFAULT_PALETTE);
    this.root.classList.toggle("cs-document", !!opts.document);
    const area = document.createElement("div");
    area.className = "cs-area";
    // (the text area always grows with the text: the whole text is visible)
    this.root.append(this.toolbar.el, area);
    host.append(this.root);
    this.files = new FileUI(() => this.view, this.root, files);
    this.links = new LinkUI(() => this.view, this.root, items, files,
      (chosen) => this.files.pick({ images: false, chosen: (name) => chosen(name) }));
    this.tables = new TableUI(() => this.view, this.root, this.toolbar.colorChoices());
    this.formulas = new FormulaUI(() => this.view, this.root);
    this.diagrams = new DiagramUI(() => this.view, this.root, files, () => opts.diagrams?.(), (m) => this.files.notice(m));
    const docHost = () => opts.document?.();
    if (opts.document) this.doc = new DocumentUI(() => this.view, this.root, docHost, (m) => this.files.notice(m));
    // copied images carry the address of their file, so another entry can take a copy
    const base = DOMSerializer.fromSchema(schema);
    const clipboardSerializer = new DOMSerializer({ ...base.nodes, formula: (n) => {
      // a formula carries its LaTeX (its picture is made again where it is pasted) and,
      // for other programs, the address of its picture
      const img = document.createElement("img");
      img.setAttribute("data-latex", n.attrs.latex);
      if (n.attrs.display) img.setAttribute("data-display", "");
      const u = n.attrs.png ? files()?.url(n.attrs.png) : null;
      if (u) img.src = new URL(u, location.href).href;
      img.alt = n.attrs.latex;
      return img;
    }, diagram: (n) => {
      // a diagram carries the address of its PNG (with the diagram inside), as an image does
      const img = document.createElement("img");
      img.setAttribute("data-diagram", n.attrs.src ?? "");
      const u = n.attrs.src ? files()?.url(n.attrs.src) : null;
      if (u) img.src = new URL(u, location.href).href;
      img.alt = n.attrs.alt;
      if (n.attrs.width) img.width = n.attrs.width;
      return img;
    }, image: (n) => {
      const img = document.createElement("img");
      img.setAttribute("data-file", n.attrs.src ?? "");
      const u = n.attrs.src ? files()?.url(n.attrs.src) : null;
      if (u) img.src = new URL(u, location.href).href;
      img.alt = n.attrs.alt;
      if (n.attrs.width) img.width = n.attrs.width;
      return img;
    } }, base.marks);
    this.view = new EditorView(area, {
      state: this.state(opts.value, files),
      nodeViews: { image: (node, view, getPos) => new ImageView(node, view, getPos, files),
        diagram: (node, view, getPos) => new ImageView(node, view, getPos, files), formula: (node) => new FormulaView(node, files),
        placement: (node, _view, _getPos, decorations) => new PlacementView(node, docHost, decorations),
        xref: (node, view) => new XrefView(node, view, docHost), toc: (node, view) => new TocView(node, view),
        code_block: (node, view, getPos) => new CodeView(node, view, getPos) },
      clipboardSerializer,
      editable: () => !this.readonly,
      dispatchTransaction: (tr) => {
        this.view.updateState(this.view.state.apply(tr));
        this.toolbar.update(this.view.state);
        this.links.update(this.view, this.readonly);
        if (tr.docChanged) {
          if (!tr.getMeta("cs-host")) opts.onChange?.(this.value); // not the host's own change
          if (opts.onOutline) opts.onOutline(this.outline());
        }
      },
      handleDOMEvents: {
        // links open on a click when reading, and on Ctrl/⌘+click while editing
        click: (view, e) => {
          // a cross-reference: to a section of this document, or through the host
          const x = (e.target as HTMLElement).closest(".cs-xref");
          if (x && area.contains(x) && (this.readonly || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const ref = x.getAttribute("data-xref") ?? "";
            const [guid, sec] = ref.split("#");
            const h = docHost();
            if (sec && (!h?.guid || h.guid === guid) && revealSection(view, sec)) return true;
            if (!sec && h && structureKey.getState(view.state)?.entries.has(guid)) h.openEntry(guid, e.ctrlKey || e.metaKey);
            else items()?.open(ref, e.ctrlKey || e.metaKey);
            return true;
          }
          // a row of a table of contents goes to its section (like a cross-reference)
          const row = (e.target as HTMLElement).closest(".cs-toc .toc-row") as HTMLElement | null;
          if (row && area.contains(row) && (this.readonly || e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            return revealSection(view, row.dataset.section ?? "");
          }
          const a = (e.target as HTMLElement).closest("a");
          if (!a || !area.contains(a)) return false;
          e.preventDefault();
          const newTab = e.ctrlKey || e.metaKey;
          if (!this.readonly && !newTab) return false;
          openLink({ href: a.getAttribute("href"), ref: a.getAttribute("data-ref"), file: a.getAttribute("data-file") }, newTab, items(), files());
          return true;
        },
        // the right mouse button on selected cells keeps them selected (to merge them)
        mousedown: (view, e) => {
          if (e.button === 2) return !!(e.target as HTMLElement).closest(".selectedCell");
          // Shift+click on a picture, diagram or formula extends the text selection over it (the
          // browser would select it alone)
          const atom = e.shiftKey && e.button === 0 ? (e.target as HTMLElement).closest(".cs-img, .cs-formula") : null;
          if (!atom || !area.contains(atom)) return false;
          const at = view.posAtDOM(atom, 0);
          const n = view.state.doc.nodeAt(at);
          if (!n?.isInline) return false;
          const anchor = view.state.selection.anchor;
          e.preventDefault();
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, anchor <= at ? at + n.nodeSize : at)));
          view.focus();
          return true;
        },
        // the table menu on the right mouse button; outside tables the browser's own menu
        contextmenu: (view, e) => {
          if (this.readonly) return false;
          // a placed entry: its menu
          const placed = (e.target as HTMLElement).closest(".cs-placement");
          if (placed && area.contains(placed) && this.doc) {
            const pos = view.posAtDOM(placed, 0);
            if (view.state.doc.nodeAt(pos)?.type !== schema.nodes.placement) return false;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            e.preventDefault();
            this.doc.openMenu({ x: e.clientX, y: e.clientY });
            return true;
          }
          // a code listing: its menu (copy, line numbers, language)
          const code = (e.target as HTMLElement).closest(".cs-code");
          if (code && area.contains(code)) {
            const at = codeAround(view.state, view.posAtDOM(code, 0));
            if (!at) return false;
            // the cursor goes into the listing, unless the selection is in it already
            if (codeAt(view.state)?.pos !== at.pos) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at.pos + 1)));
            e.preventDefault();
            this.openCodeMenu(at.pos, { x: e.clientX, y: e.clientY });
            return true;
          }
          // a table of contents: its menu
          const toc = (e.target as HTMLElement).closest(".cs-toc");
          if (toc && area.contains(toc) && this.doc) {
            const pos = view.posAtDOM(toc, 0);
            if (view.state.doc.nodeAt(pos)?.type !== schema.nodes.toc) return false;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            e.preventDefault();
            this.doc.openTocMenu({ x: e.clientX, y: e.clientY });
            return true;
          }
          // an image: its menu
          const img = (e.target as HTMLElement).closest(".cs-img");
          if (img && area.contains(img)) {
            const pos = view.posAtDOM(img, 0);
            if (!isPicture(view.state.doc.nodeAt(pos))) return false;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            e.preventDefault();
            this.files.openMenu({ x: e.clientX, y: e.clientY }, this.diagramsOn() ? () => { void this.diagrams.edit(); } : undefined);
            return true;
          }
          // a formula: its menu
          const formula = (e.target as HTMLElement).closest(".cs-formula");
          if (formula && area.contains(formula)) {
            const pos = view.posAtDOM(formula, 0);
            if (view.state.doc.nodeAt(pos)?.type !== schema.nodes.formula) return false;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            e.preventDefault();
            this.formulas.openMenu({ x: e.clientX, y: e.clientY });
            return true;
          }
          if (!(e.target as HTMLElement).closest("td, th")) return false;
          const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
          // a click outside the selected cells moves the cursor there; inside, the selection stays (merge)
          if (hit && !(e.target as HTMLElement).closest(".selectedCell")) {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
          }
          if (!tableAt(view.state)) return false;
          e.preventDefault();
          this.tables.openMenu({ x: e.clientX, y: e.clientY });
          return true;
        },
        // a double click on a formula edits it
        dblclick: (view, e) => {
          // a placed entry opens
          const placed = (e.target as HTMLElement).closest(".cs-placement");
          if (placed && area.contains(placed)) {
            const pos = view.posAtDOM(placed, 0);
            const n = view.state.doc.nodeAt(pos);
            if (n?.type !== schema.nodes.placement) return false;
            e.preventDefault();
            docHost()?.openEntry(n.attrs.guid, e.ctrlKey || e.metaKey);
            return true;
          }
          // a diagram: draw.io
          const diagram = (e.target as HTMLElement).closest(".cs-diagram");
          if (diagram && area.contains(diagram) && !this.readonly && this.diagramsOn()) {
            const pos = view.posAtDOM(diagram, 0);
            if (view.state.doc.nodeAt(pos)?.type !== schema.nodes.diagram) return false;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
            e.preventDefault();
            void this.diagrams.edit();
            return true;
          }
          const formula = (e.target as HTMLElement).closest(".cs-formula");
          if (this.readonly || !formula || !area.contains(formula)) return false;
          const pos = view.posAtDOM(formula, 0);
          if (view.state.doc.nodeAt(pos)?.type !== schema.nodes.formula) return false;
          view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
          e.preventDefault();
          this.formulas.edit({ x: e.clientX, y: e.clientY + 12 });
          return true;
        },
        focus: (view) => { this.links.update(view, this.readonly); return false; },
        blur: () => { this.links.hideBubble(); return false; },
      },
      // pasted tables keep what the editor supports; a table in a table becomes lines of text
      transformPastedHTML: flattenNestedTables,
      handleDrop: (view, e, _slice, moved) => {
        if (moved || this.readonly) return false;
        const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (!this.pasteFiles(view, e.dataTransfer, at?.pos)) return false;
        e.preventDefault();
        return true;
      },
      // a pasted web address links the selected text, or is inserted as a link
      handlePaste: (view, e) => {
        if (this.pasteFiles(view, e.clipboardData)) return true;
        const text = e.clipboardData?.getData("text/plain").trim() ?? "";
        const href = /\n/.test(text) ? null : safeHref(text);
        if (!href) return false;
        const link = schema.marks.link.create({ href });
        const { empty, from, to } = view.state.selection;
        const tr = view.state.tr;
        if (empty) tr.replaceSelectionWith(schema.text(text, link.addToSet(view.state.storedMarks ?? view.state.selection.$from.marks())), false);
        else tr.removeMark(from, to, schema.marks.link).addMark(from, to, link);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    });
    this.toolbar.update(this.view.state);
  }

  /** Pasted or dropped files (a screenshot, files from the file manager) are added to the
   *  entry and put into the text; HTML with text (e.g. from Word, which adds a picture of
   *  the selection) is pasted as text instead. */
  private pasteFiles(view: EditorView, data: DataTransfer | null, pos?: number): boolean {
    const list = [...(data?.files ?? [])];
    if (!list.length) return false;
    const html = data?.getData("text/html") ?? "";
    if (html && new DOMParser().parseFromString(html, "text/html").body.textContent?.trim()) return false;
    const files = this.opts.files?.();
    if (!files) { this.files.notice("Files are kept with a saved item; they cannot be added here."); return true; }
    void addFiles(view, files, list, (m) => this.files.notice(m), pos);
    return true;
  }

  /** The stored form of the current text (a document's content in a document). */
  get value(): RichText | DocNode[] { return this.opts.document ? documentToStorage(this.view.state.doc) : toStorage(this.view.state.doc); }

  /** Replaces the text (and the undo history); a document keeps its title. */
  set value(v: RichText | DocNode[] | null) {
    const titled = this.view.state.doc.firstChild?.type === schema.nodes.doc_title;
    this.view.updateState(this.state(v, undefined, titled ? this.title : undefined));
    this.toolbar.update(this.view.state);
  }

  /** In a document: its title, the first line of the editor. */
  get title(): string { return documentTitle(this.view.state.doc); }

  /** In a document: changes the title in place (the cursor and the undo history stay); for the
   *  host, so no change is reported. */
  setTitle(title: string) {
    const t = title.replace(/[\r\n]+/g, " ");
    const node = this.view.state.doc.firstChild;
    if (!this.opts.document || node?.type !== schema.nodes.doc_title || node.textContent === t) return;
    this.view.dispatch(this.view.state.tr.replaceWith(1, 1 + node.content.size, t ? schema.text(t) : [])
      .setMeta("addToHistory", false).setMeta("cs-host", true));
  }

  /** In a document: replaces the title and the content (and the undo history). */
  setDocument(content: DocNode[] | null, title: string) {
    this.view.updateState(this.state(content, undefined, title));
    this.toolbar.update(this.view.state);
  }

  /** Read-only shows the text without the toolbar. */
  setReadonly(on: boolean) {
    if (on === this.readonly) return;
    this.readonly = on;
    this.root.classList.toggle("readonly", on);
    this.toolbarHost?.classList.toggle("readonly", on);
    if (on) { this.links.close(false); this.links.hideBubble(); this.tables.close(); this.files.close(); this.formulas.close(); this.diagrams.close(); this.doc?.close(); }
    this.view.setProps({}); // editable is asked again
  }

  /** Shows the toolbar again for what the host now offers (e.g. diagrams); in a document also
   *  the placed entries and cross-references (e.g. once the host knows their names). */
  refresh() {
    this.toolbar.update(this.view.state);
    if (this.opts.document) this.view.dispatch(this.view.state.tr.setMeta("cs-refresh", true));
  }

  /** In a document: puts the GUIDs the save gave new entries in place of their keys (in place:
   *  the cursor and the undo history stay). */
  renameEntries(names: Map<string, string>) {
    if (this.opts.document) renameEntries(names)(this.view.state, this.view.dispatch);
  }

  /** In a document: its sections, in order. */
  outline(): OutlineItem[] { return structureKey.getState(this.view.state)?.sections ?? []; }

  /** In a document: puts the cursor into a section's heading and scrolls there. */
  revealSection(id: string): boolean { return revealSection(this.view, id); }

  /** In a document: moves a section into a parent (null: the top level), before the parent's
   *  index-th section. */
  moveSection(id: string, parentId: string | null, index: number): boolean {
    if (this.readonly) return false;
    return moveSection(id, parentId, index)(this.view.state, this.view.dispatch);
  }

  focus() { this.view.focus(); }
  /** Takes the toolbar out of the editor so the host can place it (e.g. in its own bar). It
   *  keeps the editor's looks; it goes when the editor goes. */
  detachToolbar(): HTMLElement {
    if (!this.toolbarHost) {
      const h = document.createElement("div");
      h.className = this.root.className + " cs-tbhost";
      h.append(this.toolbar.el);
      this.root.classList.add("cs-tbaway");
      this.toolbarHost = h;
    }
    return this.toolbarHost;
  }
  private toolbarHost?: HTMLElement;

  destroy() { this.toolbarHost?.remove(); this.links.destroy(); this.tables.destroy(); this.files.destroy(); this.formulas.destroy(); this.diagrams.destroy(); this.doc?.destroy(); this.view.destroy(); this.root.remove(); }

  private tableMenu(state: EditorState): boolean {
    if (this.readonly || !tableAt(state)) return false;
    this.tables.openMenu();
    return true;
  }

  /** The menu of the code listing at pos. */
  private openCodeMenu(pos: number, at?: { x: number; y: number }) {
    this.closeCodeMenu?.();
    const view = this.view;
    const c = view.coordsAtPos(view.state.selection.head);
    this.closeCodeMenu = popupMenu(this.root, "Code", "cs-codemenu",
      codeMenu(pos, () => { void copyCode(view.state.doc.nodeAt(pos)?.textContent ?? ""); }), view.state, at ?? { x: c.left, y: c.bottom + 4 },
      (it) => {
        if (it.cmd) it.cmd(this.view.state, this.view.dispatch);
        else it.run?.();
        this.view.focus();
      }, () => this.view.focus());
  }
  private closeCodeMenu?: () => void;

  /** The menu of what the cursor is in, from the keyboard: a code listing's, else a table's. */
  private contextKey(state: EditorState): boolean {
    if (this.readonly) return false;
    const code = codeAt(state);
    if (!code) return this.tableMenu(state);
    this.openCodeMenu(code.pos);
    return true;
  }

  /** Whether diagrams can be drawn: the entry's files and draw.io are there. */
  private diagramsOn() { return !!this.opts.files?.() && !!this.opts.diagrams?.(); }

  private run(cmd: Command) {
    cmd(this.view.state, this.view.dispatch);
    this.view.focus();
  }

  private state(value: RichText | DocNode[] | null | undefined, files: () => EntryFiles | undefined = () => this.opts.files?.(), title: string | undefined = this.opts.title): EditorState {
    const isDoc = !!this.opts.document;
    // in a document, headings first: Tab / Shift+Tab change a section's level, Enter starts its
    // content, Backspace at its start makes it normal text
    const docKeys: Record<string, Command> = isDoc ? {
      // (each takes over the browser's cursor first: a key right after a click acts where the cursor now is)
      "Tab": synced(chainCommands(titleTab, demoteSection)), "Shift-Tab": synced(promoteSection), "Enter": synced(splitHeading),
      "Backspace": backspaceStructure, "Delete": synced(deleteStructure),
      "Mod-Alt-1": makeHeading, "Mod-Alt-0": makeNormal,
    } : {};
    const keys: Record<string, Command> = {
      "Mod-z": undo, "Mod-y": redo, "Shift-Mod-z": redo,
      "Mod-b": toggleFlag("bold"), "Mod-i": toggleFlag("italic"), "Mod-u": toggleFlag("underline"),
      "Mod-,": toggleFlag("sub"), "Mod-.": toggleFlag("sup"), "Mod-\\": clearFormatting,
      "Mod-l": setAlign("left"), "Mod-e": setAlign("center"), "Mod-r": setAlign("right"), "Mod-j": setAlign("justify"),
      // a new paragraph or list item keeps the alignment of the one it was split from (below: Enter)
      // in a list: indent; in a table: the next / previous cell
      "Tab": chainCommands(indent, nextCell), "Shift-Tab": chainCommands(outdent, prevCell),
      // the table menu from the keyboard
      "ContextMenu": (state) => this.contextKey(state), "Shift-F10": (state) => this.contextKey(state),
      "Mod-Alt-c": toggleCodeKey,
      // Enter on a selected formula edits it
      "Enter": (state, dispatch) => {
        if (!this.readonly && selectedDiagram(state) && this.diagramsOn()) { void this.diagrams.edit(); return true; }
        if (this.readonly || !selectedFormula(state)) return keepAlign(chainCommands(splitListItem(schema.nodes.list_item), baseKeymap.Enter))(state, dispatch);
        this.formulas.edit();
        return true;
      },
      "Mod-k": () => { if (this.readonly) return false; this.links.edit(); return true; },
      "Shift-Enter": (state, dispatch) => {
        dispatch?.(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView());
        return true;
      },
    };
    const state = EditorState.create({ doc: isDoc ? documentFromStorage(value as DocNode[], title) : fromStorage(value as RichText),
      plugins: [history(), keymap(codeKeys), codeNumbers(), columnResizing({ View: StyledTableView }), tableEditing(), tableEdges, imageImporter(files, (m) => this.files.notice(m)),
        formulaPictures(files, (m) => this.files.notice(m)), ...(isDoc ? [structurePlugin(() => this.opts.document?.()), keymap(docKeys)] : []),
        keymap(keys), keymap(baseKeymap)] });
    // irregular stored tables (rows of different lengths) are completed, outside the undo history
    const fix = fixTables(state);
    return fix ? state.apply(fix.setMeta("addToHistory", false)) : state;
  }
}
