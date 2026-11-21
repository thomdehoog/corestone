import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import { ButtonBar, customColor, prefs, recentSwatches, setTip, swatch, tint, type ColorChoices, type Palette, type StripePreset, type Tip } from "@corestone/ui";
import { NodeSelection, type Command, type EditorState } from "prosemirror-state";
import {
  alignAt, clearFormatting, flagActive, indent, linkAt, listAt, outdent, setAlign, setValue, toggleFlag, toggleList, valueAt,
} from "./commands";
import { isInTable } from "prosemirror-tables";
import { icon } from "./icons";
import { FONTS, SIZE_MAX, SIZE_MIN, SIZES, schema, type Align, type Flag } from "./schema";
import { codeActive, codeAt, toggleCode } from "./code";
import { canPlace, demoteBlocked, demoteSection, makeHeading, makeNormal, promoteBlocked, promoteSection, selectedText, styleAt } from "./structure";

// The toolbar of docs/design/Corestone editor toolbar demo.html: in a field
// without paragraph styles and entries, in a document with them; split buttons
// that repeat the last-used option, colour menus with a shared history, and
// tooltips that explain why a button is unavailable.

/** What the toolbar needs from the editor. */
export interface ToolbarHost {
  state(): EditorState;
  run(cmd: Command): void;
  /** Opens the link popover for the selection. */
  link(): void;
  /** Whether the entry's files are available (images, file links). */
  files(): boolean;
  /** Opens the image picker, at the mouse pointer when the toolbar was clicked. */
  image(at?: { x: number; y: number }): void;
  /** Opens the table size grid, at the mouse pointer when the toolbar was clicked. */
  table(at?: { x: number; y: number }): void;
  /** Opens the formula dialog (for the selected formula, or a new one). */
  formula(at?: { x: number; y: number }): void;
  /** Whether diagrams can be drawn (the entry's files and draw.io are there). */
  diagrams(): boolean;
  /** Opens draw.io for a new diagram. */
  diagram(): void;
  /** In a document: placing entries and cross-references (absent in a field). */
  structure?: {
    /** Lets the user pick entries and places them at the cursor. */
    entry(): void;
    /** Makes an entry of the selected text, of an entry type (absent: the host cannot). */
    convert?(type: string): void;
    /** The entry types convert offers (each with its name and an icon element), and the name
     *  the last one used is remembered under (e.g. the document's type). */
    entryTypes?(): { remember: string; types: EntryTypeChoice[] };
    /** Turns the selected placed entry into text (absent: the host cannot). */
    unmark?(): void;
    /** Opens the cross-reference picker. */
    xref(at?: { x: number; y: number }): void;
    /** Inserts a table of contents at the cursor. */
    toc(): void;
  };
}

export const DEFAULT_STRIPES: StripePreset[] = [
  { name: "Grey", colors: ["#ffffff", "#f3f4f6"] },
  { name: "Blue", colors: ["#ffffff", "#e3f2fd"] },
  { name: "Green", colors: ["#ffffff", "#e8f5e9"] },
  { name: "Yellow", colors: ["#ffffff", "#fffde7"] },
  { name: "Red", colors: ["#ffffff", "#ffebee"] },
  { name: "Grey and blue", colors: ["#f3f4f6", "#e3f2fd"] },
];

export const DEFAULT_PALETTE: Palette = {
  colors: ["#1f2328", "#c62828", "#e65100", "#f9a825", "#2e7d32", "#1565c0", "#6a1b9a", "#ffffff"],
  backgrounds: ["#e6e8eb", "#ffcdd2", "#ffe0b2", "#fff59d", "#c8e6c9", "#bbdefb", "#e1bee7", "#57606a"],
  allowCustom: true,
  stripes: DEFAULT_STRIPES,
};

/** An entry type "Convert selection to entry" can make. */
export interface EntryTypeChoice { id: string; name: string; icon: () => HTMLElement }
type Btn = HTMLButtonElement;

const LAST_KEY = "cs-editor-last";
const HISTORY_KEY = "cs-editor-colors";
const load = prefs.json;
const store = prefs.setJson;


export class Toolbar {
  readonly el: HTMLElement;
  /** The bar's mechanics: buttons, split buttons with their menus, tooltips, the choices used last. */
  private readonly bar: ButtonBar<EditorState>;
  private history: string[] = load(HISTORY_KEY, []);
  private pointer?: { x: number; y: number };
  private readonly historyViews: (() => void)[] = [];

  constructor(private readonly host: ToolbarHost, private readonly palette: Palette = DEFAULT_PALETTE) {
    this.bar = new ButtonBar<EditorState>({ cls: "cs-tb", label: "Formatting", chevron: icon("chev", 12), state: () => this.host.state(), lastKey: LAST_KEY, tipCls: "cs-tip" });
    this.el = this.bar.el;
    this.build();
    // where the last click on the toolbar was (none for keyboard use), for panels that open there
    this.el.addEventListener("click", (e) => { this.pointer = e.detail ? { x: e.clientX, y: e.clientY } : undefined; }, true);
  }

  /** Brings every button in line with the editor state. */
  update(state: EditorState) { this.bar.update(state); }

  private run(cmd: Command) { this.host.run(cmd); }
  private can(cmd: Command) { return cmd(this.host.state()); }

  private build() {
    const S = () => this.host.state();
    // history
    this.add(this.button("undo", { text: "Undo", shortcut: "Ctrl+Z", disabled: () => (undoDepth(S()) ? null : "Nothing to undo yet.") }, () => this.run(undo)));
    this.add(this.button("redo", { text: "Redo", shortcut: "Ctrl+Y", disabled: () => (redoDepth(S()) ? null : "Nothing to redo.") }, () => this.run(redo)));
    this.add(this.button("clear", { text: "Remove formatting", shortcut: "Ctrl+\\", disabled: () => (this.can(clearFormatting) ? null : "No formatting at the cursor or in the selection.") },
      () => this.run(clearFormatting)));
    this.sep();
    // structure (documents): paragraph style and entries
    const st = this.host.structure;
    if (st) {
      // paragraph style and heading level: ¶ (normal text), then H− (one level up), H (heading), H+
      // (one level deeper); the main button repeats the last used (at first H), like the other groups
      const noStyle = () => (styleAt(S()) ? null : "Only paragraphs of the text have a style, not lists, tables or the title.");
      this.split("heading", "Heading level", [
        { i: "para", tip: { text: "Normal text", shortcut: "Ctrl+Alt+0", disabled: noStyle }, run: () => this.run(makeNormal), pressed: (s) => styleAt(s) === "normal" },
        { i: "hminus", tip: { text: "Heading one level up", shortcut: "Shift+Tab", disabled: () => promoteBlocked(S()) }, run: () => this.run(promoteSection) },
        { i: "heading", tip: { text: "Heading", shortcut: "Ctrl+Alt+1", disabled: noStyle }, run: () => this.run(makeHeading), pressed: (s) => styleAt(s) === "heading" },
        { i: "hplus", tip: { text: "Heading one level deeper", shortcut: "Tab", disabled: () => demoteBlocked(S()) }, run: () => this.run(demoteSection) },
      ], "heading");
      // entries: insert; and one button that makes an entry of the selected text, or (a placed
      // entry selected) turns that entry into text
      const insert = { i: "entry", tip: { text: "Insert entries…", disabled: () => (this.can(canPlace) ? null : "Place the cursor in the text first.") }, run: () => st.entry() };
      if (st.convert && st.unmark && st.entryTypes) this.entriesGroup(st as Required<NonNullable<ToolbarHost["structure"]>>, insert);
      else this.add(this.button(insert.i, insert.tip, insert.run));
      this.sep();
    }
    // character formatting
    const flags: { i: Flag; t: string; k?: string }[] = [
      { i: "bold", t: "Bold", k: "Ctrl+B" }, { i: "italic", t: "Italic", k: "Ctrl+I" }, { i: "underline", t: "Underline", k: "Ctrl+U" },
      { i: "strike", t: "Strikethrough" }, { i: "sub", t: "Subscript", k: "Ctrl+," }, { i: "sup", t: "Superscript", k: "Ctrl+." },
    ];
    const noFormat = () => (codeAt(S()) ? "A code listing has no formatting of its own." : null);
    this.split("fmt", "Text format", [...flags.map((f) => ({ i: f.i as string, tip: { text: f.t, shortcut: f.k, disabled: noFormat }, run: () => this.run(toggleFlag(f.i)),
      pressed: (s: EditorState) => flagActive(s, f.i) })),
    // code: part of a line selected becomes code within the line, otherwise the paragraphs become a listing
    { i: "code", tip: { text: "Code", shortcut: "Ctrl+Alt+C", disabled: () => (this.can(toggleCode) ? null : "Code is made of text: not of a heading, a table or a placed entry.") },
      run: () => this.run(toggleCode), pressed: (s: EditorState) => codeActive(s) }]);
    this.colour("color", "fcolor", "Font color", "#c62828");
    this.colour("bg", "bcolor", "Background color", "#fff59d");
    this.font();
    this.size();
    this.sep();
    // layout
    this.split("list", "Lists & indent", [
      { i: "ul", tip: { text: "Bulleted list" }, run: () => this.run(toggleList(schema.nodes.bullet_list)), pressed: (s) => listAt(s) === "ul" },
      { i: "ol", tip: { text: "Numbered list" }, run: () => this.run(toggleList(schema.nodes.ordered_list)), pressed: (s) => listAt(s) === "ol" },
      { i: "outdent", tip: { text: "Decrease indent", shortcut: "Shift+Tab", disabled: () => (this.can(outdent) ? null : "Not in a list item.") }, run: () => this.run(outdent) },
      { i: "indent", tip: { text: "Increase indent", shortcut: "Tab", disabled: () => (this.can(indent) ? null : "Only list items after the first can be indented.") }, run: () => this.run(indent) },
    ]);
    const aligns: { i: string; a: Align; t: string; k: string }[] = [
      { i: "al", a: "left", t: "Align left", k: "Ctrl+L" }, { i: "ac", a: "center", t: "Center", k: "Ctrl+E" },
      { i: "ar", a: "right", t: "Align right", k: "Ctrl+R" }, { i: "aj", a: "justify", t: "Justify", k: "Ctrl+J" },
    ];
    this.split("align", "Alignment", aligns.map((x) => ({ i: x.i, tip: { text: x.t, shortcut: x.k }, run: () => this.run(setAlign(x.a)),
      pressed: (s: EditorState) => alignAt(s) === x.a })));
    this.sep();
    this.split("ins", "Insert", [
      { i: "link", tip: { text: "Link…", shortcut: "Ctrl+K" }, run: () => this.host.link(), pressed: (s: EditorState) => !!linkAt(s) },
      { i: "table", tip: { text: "Table…", disabled: () => (isInTable(S()) ? "No tables in tables. Right-click the table for rows, columns and its properties." : null) },
        run: () => this.host.table(this.pointer) },
      { i: "image", tip: { text: "Image…", disabled: () => (this.host.files() ? null : "Images are kept with a saved item; not available here.") },
        run: () => this.host.image(this.pointer) },
      { i: "diagram", tip: { text: "Diagram…", disabled: () => (this.host.diagrams() ? null
        : this.host.files() ? "Diagrams are not available: draw.io is not installed on this server." : "Diagrams are kept with a saved item; not available here.") },
        run: () => this.host.diagram() },
      { i: "formula", tip: { text: "Formula…", disabled: () => (this.host.files() ? null : "Formulas are kept with a saved item; not available here.") },
        run: () => this.host.formula(this.pointer) },
      ...(st ? [{ i: "xref", tip: { text: "Cross-reference…" }, run: () => st.xref(this.pointer) },
        { i: "toc", tip: { text: "Table of contents", disabled: () => (this.can(canPlace) ? null : "Place the cursor in the text first.") }, run: () => st.toc() }] : []),
    ]);
  }

  // --- building blocks ---

  private add(el: HTMLElement) { this.bar.add(el); }
  private sep() { this.bar.sep(); }
  private button(name: string, tip: Tip, act: () => void): Btn { return this.bar.button(name, icon(name), tip, act); }
  private wrap(main: HTMLElement, label: string, menu: HTMLElement, extra = "") { this.bar.group(main, label, menu, extra); }
  private closeMenus() { this.bar.closeMenus(); }
  private remember(key: string, v: string) { this.bar.remember(key, v); }

  /** The Entries group: Insert entries…, a convert button per entry type the host offers (its
   *  icon, its name on hover) and Turn into text. The main button repeats the last used (the
   *  last type, remembered per host name); a convert with a placed entry selected turns that
   *  entry into text instead. The type buttons follow the host's list (it may come later). */
  private entriesGroup(st: Required<NonNullable<ToolbarHost["structure"]>>, insert: { i: string; tip: Tip; run: () => void }) {
    const S = () => this.host.state();
    const onEntry = (s: EditorState) => s.selection instanceof NodeSelection && s.selection.node.type === schema.nodes.placement;
    const whyNot = () => { const r = selectedText(S()); return typeof r === "string" ? r : null; };
    type Item = { key: string; tip: Tip; run: () => void; icon: () => Node };
    const svg = (name: string) => () => { const t = document.createElement("template"); t.innerHTML = icon(name); return t.content; };
    const unmark: Item = { key: "unmark", icon: svg("unentry"), run: () => st.unmark(),
      tip: { text: "Turn the entry into text", disabled: () => (onEntry(S()) ? null : "Select a placed entry first.") } };
    const ins: Item = { key: "insert", icon: svg(insert.i), tip: insert.tip, run: insert.run };
    let offer = st.entryTypes();
    const convert = (t: EntryTypeChoice): Item => ({ key: "to:" + t.id, icon: t.icon, run: () => st.convert(t.id), tip: { text: `Convert selection to ${t.name}`, disabled: whyNot } });
    const lastType = () => offer.types.find((t) => t.id === this.bar.last("entrytype:" + offer.remember)) ?? offer.types[0];
    // the main button: insert, the last type's convert, or turn into text
    // (s absent: while the toolbar is built, before the editor has a state)
    const mainItem = (s?: EditorState): Item => {
      const used = this.bar.last("entries");
      // convert and turn into text are one action that follows the selection: a placed entry
      // selected turns into text, otherwise the selection converts (to the last type)
      if (used === "unmark" || used === "convert") return (s && onEntry(s)) || !lastType() ? unmark : convert(lastType()!);
      return ins;
    };
    const menu = document.createElement("div");
    menu.className = "pop";
    const main = this.button("entry", ins.tip, () => shown.run());
    let shown = ins;
    const show = (it: Item) => {
      shown = it;
      main.replaceChildren(it.icon());
      main.dataset.cmd = it.key;
      main.setAttribute("aria-label", it.tip.text);
      setTip(main, it.tip);
    };
    const fill = () => {
      const items = [ins, ...offer.types.map(convert), unmark];
      menu.replaceChildren(...items.map((it) => {
        const b = this.button(it.key, it.tip, () => {
          it.run();
          this.remember("entries", it.key === "insert" ? "insert" : it.key === "unmark" ? "unmark" : "convert");
          if (it.key.startsWith("to:")) this.remember("entrytype:" + offer.remember, it.key.slice(3));
          this.closeMenus();
          this.update(S());
        });
        b.replaceChildren(it.icon());
        return b;
      }));
    };
    fill();
    show(mainItem());
    this.wrap(main, "Entries", menu);
    let known = JSON.stringify(offer.types.map((t) => t.id)) + offer.remember;
    this.bar.onUpdate((s) => {
      const next = st.entryTypes();
      const sig = JSON.stringify(next.types.map((t) => t.id)) + next.remember;
      if (sig !== known) { known = sig; offer = next; fill(); }
      const it = mainItem(s);
      if (it.key !== shown.key) show(it);
    });
  }

  /** A split button: the main part repeats the last-used item, ▾ shows them all. */
  private split(key: string, label: string, items: { i: string; tip: Tip; run: () => void; pressed?: (s: EditorState) => boolean }[], main0?: string) {
    this.bar.split(key, label, items.map((it) => ({ id: it.i, icon: icon(it.i), tip: it.tip, run: it.run, pressed: it.pressed })), main0);
  }

  /** Font or background colour: the main button applies the last colour, ▾ opens palette, picker and history. */
  private colour(mark: "color" | "bg", name: string, label: string, fallback: string) {
    const type = schema.marks[mark];
    const colors = this.colors(mark);
    let c = this.bar.last(mark) ?? fallback;
    // a font colour remembered as background from before markers had their own colours: its marker
    const ink = this.palette.colors.indexOf(c);
    if (mark === "bg" && ink >= 0 && colors[ink] !== c) c = colors[ink];
    const main = this.button(name, { text: label }, () => this.run(setValue(type, c)));
    const draw = () => {
      main.innerHTML = `<span class="cw">${icon(name)}<i style="background:${c}"></i></span>`;
      setTip(main, { text: `${label} (${c})` });
    };
    draw();
    const menu = document.createElement("div");
    menu.className = "pop cgrid";
    const pick = (v: string | null) => {
      this.run(setValue(type, v));
      if (v) { c = v; this.remember(mark, v); draw(); }
      this.closeMenus();
    };
    colors.forEach((v, n) => { const name = this.palette.names?.[n]; menu.append(swatch(v, pick, name ?? v, name ? `${name} (${v})` : v)); });
    if (this.palette.allowCustom !== false) {
      menu.append(customColor("b", icon("pick"), (v) => { this.addHistory(v); pick(v); }));
      const recent = recentSwatches(8, () => this.history, pick);
      menu.append(...recent.slots);
      const bin = this.button("trash", { text: "Clear color history",
        disabled: () => (this.history.length ? null : "No colors in the history yet. Colors you pick with the color picker appear here.") },
      () => { this.history = []; store(HISTORY_KEY, this.history); this.historyViews.forEach((f) => f()); });
      menu.append(bin);
      this.historyViews.push(recent.render);
    }
    const none = this.button("none", { text: mark === "color" ? "Automatic color" : "No background",
      disabled: () => (valueAt(this.host.state(), type) ? null : "No color set here.") }, () => pick(null));
    none.classList.add("none");
    menu.append(none);
    this.wrap(main, label, menu);
  }

  /** The swatches of the font or the background colour menu. */
  private colors(mark: "color" | "bg"): string[] {
    if (mark === "color") return this.palette.colors;
    return this.palette.colors.map((c, i) => this.palette.backgrounds?.[i] ?? tint(c));
  }

  /** The colours for the table dialog, with the same limits as the marker colour. */
  colorChoices(): ColorChoices {
    const custom = this.palette.allowCustom !== false;
    return {
      swatches: this.colors("bg"),
      custom,
      recent: () => (custom ? this.history : []),
      addRecent: (v) => { if (custom) this.addHistory(v); },
      presets: this.palette.stripes ?? DEFAULT_STRIPES,
    };
  }

  private addHistory(v: string) {
    if (this.colors("color").includes(v) || this.colors("bg").includes(v)) return;
    this.history = [...this.history.filter((x) => x !== v), v].slice(-8);
    store(HISTORY_KEY, this.history);
    this.historyViews.forEach((f) => f());
  }

  /** The font of the selection; picking one sets it, "Default" removes it. */
  private font() {
    const type = schema.marks.font;
    const main: Btn = document.createElement("button");
    main.type = "button";
    main.className = "b fontsel";
    const menu = document.createElement("div");
    menu.className = "pop col";
    const options: { name: string; css: string | null }[] = [{ name: "Default", css: null }, ...FONTS];
    for (const f of options) {
      const o: Btn = document.createElement("button");
      o.type = "button";
      o.className = "f";
      o.textContent = f.name;
      if (f.css) o.style.fontFamily = f.css;
      setTip(o, { text: f.css ? f.name : "The field's default font" });
      o.onclick = (e) => { e.stopPropagation(); this.run(setValue(type, f.css ? f.name : null)); this.closeMenus(); };
      menu.append(o);
    }
    main.onclick = (e) => { e.stopPropagation(); (main.nextElementSibling as HTMLElement).click(); };
    this.wrap(main, "Font", menu, "gap");
    this.bar.onUpdate((s) => {
      const v = valueAt(s, type) as string | null;
      main.innerHTML = '<span class="fn"></span>';
      main.firstElementChild!.textContent = v ?? "Default";
      main.style.fontFamily = FONTS.find((f) => f.name === v)?.css ?? "";
      setTip(main, { text: "Font: " + (v ?? "default") });
    });
  }

  /** The size of the selection in points: type any value or pick one. */
  private size() {
    const type = schema.marks.size;
    const input = document.createElement("input");
    input.className = "sz";
    input.setAttribute("aria-label", "Font size");
    input.placeholder = "–";
    setTip(input, { text: `Font size in points (${SIZE_MIN}–${SIZE_MAX}): type a value or pick one` });
    const apply = () => {
      const raw = input.value.trim();
      if (!raw) { this.run(setValue(type, null)); return; }
      const n = Math.round(Number(raw) * 2) / 2;
      if (!Number.isFinite(n) || n < SIZE_MIN || n > SIZE_MAX) { input.classList.add("bad"); return; }
      input.classList.remove("bad");
      this.run(setValue(type, n));
    };
    input.onchange = apply;
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } };
    const menu = document.createElement("div");
    menu.className = "pop col";
    menu.style.minWidth = "80px";
    for (const v of [null, ...SIZES]) {
      const o = document.createElement("button");
      o.type = "button";
      o.className = "f";
      o.textContent = v === null ? "Default" : String(v);
      o.onclick = (e) => { e.stopPropagation(); this.run(setValue(type, v)); this.closeMenus(); };
      menu.append(o);
    }
    this.wrap(input, "Font size", menu);
    this.bar.onUpdate((s) => {
      if (document.activeElement === input) return; // never overwrite what is being typed
      const v = valueAt(s, type);
      input.value = v === null ? "" : String(v);
      input.classList.remove("bad");
    });
  }
}
