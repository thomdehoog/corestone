import type { Node } from "prosemirror-model";
import { Plugin, TextSelection, type Command, type EditorState } from "prosemirror-state";
import {
  addColumn, addColumnAfter, addColumnBefore, addRow, addRowAfter, addRowBefore, cellAround, CellSelection, deleteColumn,
  deleteRow, deleteTable, goToNextCell, isInTable, mergeCells, removeColumn, removeRow, splitCell, TableMap, TableView,
} from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";
import { icon } from "./icons";
import { buildMenu, runItem, type MenuItem } from "./menu";
import { schema, tableClass, tableStyle, type Borders, type Stripes } from "./schema";
import { button, customColor, dialogHead, el, Overlay, swatch, type ColorChoices } from "@corestone/ui";

// Tables: inserting one (a size grid), the context menu (rows, columns,
// header format, merging) and the Properties dialog (size, stripes,
// borders), Tab between cells, and the cleanup of pasted tables (no tables
// in tables).

/** A new table, its first row formatted as header. */
export function insertTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    if (isInTable(state)) return false; // no tables in tables
    if (dispatch) {
      const cell = (header: boolean) => (header ? schema.nodes.table_header : schema.nodes.table_cell).createAndFill()!;
      const table = schema.nodes.table.create(null,
        Array.from({ length: rows }, (_, r) => schema.nodes.table_row.create(null, Array.from({ length: cols }, () => cell(r === 0)))));
      const tr = state.tr.replaceSelectionWith(table);
      // the cursor into the first cell
      let first = -1;
      tr.doc.descendants((n, pos) => {
        if (first < 0 && n === table) first = pos;
        return first < 0;
      });
      if (first >= 0) tr.setSelection(TextSelection.near(tr.doc.resolve(first + 3)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** The cells the selection covers: the selected cells, or the cell at the cursor. */
function selectedCells(state: EditorState): { node: Node; pos: number }[] {
  const sel = state.selection;
  if (sel instanceof CellSelection) {
    const out: { node: Node; pos: number }[] = [];
    sel.forEachCell((node, pos) => out.push({ node, pos }));
    return out;
  }
  const $cell = cellAround(sel.$head);
  return $cell?.nodeAfter ? [{ node: $cell.nodeAfter, pos: $cell.pos }] : [];
}

/** Whether every selected cell is formatted as header. */
export function isHeader(state: EditorState): boolean {
  const cells = selectedCells(state);
  return cells.length > 0 && cells.every((c) => c.node.type === schema.nodes.table_header);
}

/** Formats the selected cells (a row, a column, or any cells) as header, or back as normal
 *  cells when they all are headers already. A header is formatting only. */
export const formatHeader: Command = (state, dispatch) => {
  const cells = selectedCells(state);
  if (!cells.length) return false;
  if (dispatch) {
    const type = isHeader(state) ? schema.nodes.table_cell : schema.nodes.table_header;
    const tr = state.tr;
    for (const c of cells) tr.setNodeMarkup(c.pos, type, c.node.attrs);
    dispatch(tr);
  }
  return true;
};

export interface TableProps { rows: number; cols: number; stripes: Stripes | null; colors: [string, string] | null; borders: Borders | null }
export const MAX_ROWS = 100, MAX_COLS = 100;

/** The current properties of the table at the cursor. */
export function propsOf(state: EditorState): TableProps | null {
  const t = tableAt(state);
  if (!t) return null;
  const map = TableMap.get(t.node);
  return { rows: map.height, cols: map.width, stripes: t.node.attrs.stripes, colors: t.node.attrs.colors, borders: t.node.attrs.borders };
}

/** Whether shrinking the table at the cursor to rows × cols drops cells that hold text. */
export function dropsText(state: EditorState, rows: number, cols: number): boolean {
  const t = tableAt(state);
  if (!t) return false;
  const map = TableMap.get(t.node);
  let drops = false;
  t.node.forEach((row, rowOffset) => row.forEach((cell, cellOffset) => {
    const r = map.findCell(rowOffset + 1 + cellOffset);
    if ((r.top >= rows || r.left >= cols) && cell.textContent.trim()) drops = true;
  }));
  return drops;
}

/** Sets the style of the table at the cursor and its size; rows and columns are added or
 *  removed at the end. */
export function setTableProps(p: TableProps): Command {
  return (state, dispatch) => {
    const t = tableAt(state);
    if (!t) return false;
    if (dispatch) {
      const tr = state.tr.setNodeMarkup(t.pos, null, { ...t.node.attrs, stripes: p.stripes, colors: p.stripes ? p.colors : null, borders: p.borders });
      const rect = () => {
        const table = tr.doc.nodeAt(t.pos)!;
        return { map: TableMap.get(table), table, tableStart: t.pos + 1, left: 0, top: 0, right: 0, bottom: 0 };
      };
      const rows = clamp(p.rows, 1, MAX_ROWS), cols = clamp(p.cols, 1, MAX_COLS);
      for (let r = rect(); r.map.width < cols; r = rect()) addColumn(tr, r, r.map.width);
      for (let r = rect(); r.map.width > cols; r = rect()) removeColumn(tr, r, r.map.width - 1);
      for (let r = rect(); r.map.height < rows; r = rect()) addRow(tr, r, r.map.height);
      for (let r = rect(); r.map.height > rows; r = rect()) removeRow(tr, r, r.map.height - 1);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.trunc(n) || lo, lo), hi);

/** Tab: the next cell; in the last cell a new row. Lists in cells still indent first (see the keymap). */
export const nextCell: Command = (state, dispatch, view) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  if (dispatch && view && addRowAfter(state, dispatch)) goToNextCell(1)(view.state, view.dispatch);
  return true;
};
export const prevCell: Command = (state, dispatch) => (isInTable(state) ? goToNextCell(-1)(state, dispatch) || true : false);

/** A table at the start or the end of the text gets an empty line before / after it, so the
 *  cursor can get there. These lines are not stored (see model.ts). */
export const tableEdges = new Plugin({
  appendTransaction: (trs, _old, state) => {
    if (!trs.some((t) => t.docChanged)) return null;
    const doc = state.doc;
    const tr = state.tr;
    if (doc.lastChild?.type === schema.nodes.table) tr.insert(doc.content.size, schema.nodes.paragraph.create());
    if (doc.firstChild?.type === schema.nodes.table) tr.insert(0, schema.nodes.paragraph.create());
    return tr.docChanged ? tr : null;
  },
});

/** Pasted HTML: a table inside a table cell becomes lines of text (one per row, cells separated by " | "). */
export function flattenNestedTables(html: string): string {
  if (!/<table/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  let inner = [...doc.querySelectorAll("td table, th table")];
  while (inner.length) {
    // innermost first, so a table in a table in a table ends as text too
    const t = inner.find((x) => !x.querySelector("table")) ?? inner[0];
    const lines = [...t.querySelectorAll("tr")].map((tr) => {
      const p = doc.createElement("p");
      p.textContent = [...tr.children].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim()).join(" | ");
      return p;
    });
    t.replaceWith(...lines);
    inner = [...doc.querySelectorAll("td table, th table")];
  }
  return doc.body.innerHTML;
}

/** The table view: prosemirror-tables' (column widths), with the table's style as classes. */
export class StyledTableView extends TableView {
  constructor(node: Node, cellMinWidth: number) {
    super(node, cellMinWidth);
    this.style(node);
  }
  override update(node: Node): boolean {
    if (!super.update(node)) return false;
    this.style(node);
    return true;
  }
  private style(node: Node) {
    this.table.className = tableClass(node);
    this.table.setAttribute("style", tableStyle(node));
  }
}


/** The table's context menu (right mouse button, the menu key or Shift+F10) and its
 *  Properties dialog; the toolbar's table button opens the size grid. */
export class TableUI {
  private readonly grid: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly props: HTMLElement;
  private readonly colorPop: HTMLElement;
  private readonly overlay: Overlay;

  constructor(private readonly view: () => EditorView, root: HTMLElement, private readonly colors: ColorChoices) {
    // the size grid
    this.overlay = new Overlay({
      root, keepFocus: "input, select",
      escape: () => { const open = !this.colorPop.hidden; this.colorPop.hidden = true; return open; },
      onEscape: () => this.view().focus(),
      onClose: () => { this.colorPop.hidden = true; },
    });
    this.grid = this.overlay.panel("cs-tablegrid", "dialog", "Insert table");
    const label = el("div", "size");
    const cells = el("div", "cells");
    const R = 8, C = 10;
    const mark = (r: number, c: number) => {
      cells.querySelectorAll<HTMLElement>("button").forEach((b) => b.classList.toggle("on", +b.dataset.r! <= r && +b.dataset.c! <= c));
      label.textContent = r && c ? `${c} × ${r}` : "Table size";
    };
    for (let r = 1; r <= R; r++) for (let c = 1; c <= C; c++) {
      const b = el("button", "") as HTMLButtonElement;
      b.type = "button";
      b.dataset.r = String(r);
      b.dataset.c = String(c);
      b.setAttribute("aria-label", `${c} columns, ${r} rows`);
      b.addEventListener("mouseenter", () => mark(r, c));
      b.addEventListener("focus", () => mark(r, c));
      b.addEventListener("click", (e) => {
        e.preventDefault();
        this.close();
        const v = this.view();
        insertTable(r, c)(v.state, v.dispatch);
        v.focus();
        this.openProps(); // straight on to the table's look
      });
      cells.append(b);
    }
    cells.addEventListener("mouseleave", () => mark(0, 0));
    mark(0, 0);
    this.grid.append(label, cells);

    this.menu = this.overlay.panel("ui-pop ui-menu cs-menu cs-tablemenu", "menu", "Table");
    this.props = this.overlay.panel("cs-tableprops", "dialog", "Table properties");
    this.colorPop = el("div", "colorpop");
  }

  /** Opens the size grid with its first cell under the mouse pointer, or at the cursor. */
  openGrid(at?: { x: number; y: number }) {
    this.overlay.open(this.grid, at ?? this.cursorPoint());
    const first = this.grid.querySelector("button") as HTMLElement;
    if (at) {
      const b = first.getBoundingClientRect();
      this.grid.style.left = `${parseFloat(this.grid.style.left) + at.x - (b.left + b.width / 2)}px`;
      this.grid.style.top = `${parseFloat(this.grid.style.top) + at.y - (b.top + b.height / 2)}px`;
    }
    first.focus();
  }

  /** Opens the context menu at a point of the window (a right click), or at the cursor. */
  openMenu(at?: { x: number; y: number }) {
    const state = this.view().state;
    if (!tableAt(state)) return;
    const items: MenuItem[] = [
      { label: "Insert row", sub: [{ label: "Above", cmd: addRowBefore }, { label: "Below", cmd: addRowAfter }] },
      { label: "Insert column", sub: [{ label: "Left", cmd: addColumnBefore }, { label: "Right", cmd: addColumnAfter }] },
      { label: "Format as header", cmd: formatHeader, check: isHeader },
      { label: "Merge cells", cmd: mergeCells, onlyIf: true },
      { label: "Split cell", cmd: splitCell, onlyIf: true },
      { label: "Delete", danger: true, sub: [{ label: "Row", cmd: deleteRow }, { label: "Column", cmd: deleteColumn }, { label: "Table", cmd: deleteTable }] },
      { label: "Properties…", run: () => this.openProps(at) },
    ];
    this.menu.replaceChildren(...this.items(items, state));
    this.overlay.open(this.menu, at ?? this.cursorPoint());
    (this.menu.querySelector("[role=menuitem], [role=menuitemcheckbox]") as HTMLElement | null)?.focus();
  }

  private items(items: MenuItem[], state: EditorState): HTMLElement[] {
    return buildMenu(items, state, (it) => { this.close(); runItem(this.view(), it); });
  }

  /** The Properties dialog of the table at the cursor: its size, stripes (and their
   *  colours) and borders. */
  openProps(at?: { x: number; y: number }) {
    const cur = propsOf(this.view().state);
    if (!cur) return;
    let stripes = cur.stripes, borders = cur.borders;
    let colors: [string, string] = cur.colors ?? this.colors.presets[0]?.colors ?? ["#ffffff", "#f3f4f6"];
    let themed = !cur.colors; // no own colours: the theme's stripes

    const { head } = dialogHead("Table Properties", icon("close", 20), () => { this.close(); this.view().focus(); });

    const num = (cls: string, name: string, value: number, max: number) => {
      const l = el("label", "num");
      l.title = name;
      l.innerHTML = icon(cls, 16);
      const i = el("input", cls) as HTMLInputElement;
      i.type = "number";
      i.min = "1";
      i.max = String(max);
      i.value = String(value);
      i.setAttribute("aria-label", name);
      l.append(i);
      return { l, i };
    };
    const rows = num("rows", "Rows", cur.rows, MAX_ROWS), cols = num("cols", "Columns", cur.cols, MAX_COLS);
    const size = el("div", "size");
    const times = el("span", "times");
    times.textContent = "×";
    size.append(rows.l, times, cols.l);

    /** A row of icon buttons of which one is chosen. */
    const choice = <T extends string>(cls: string, name: string, opts: [T | null, string][], value: T | null, set: (v: T | null) => void) => {
      const g = el("div", "choice " + cls);
      g.setAttribute("role", "radiogroup");
      g.setAttribute("aria-label", name);
      const bs = opts.map(([v, label]) => {
        const b = button({ cls: "opt", label, html: icon(`${cls[0]}-${v ?? "none"}`, 20) });
        b.setAttribute("role", "radio");
        b.addEventListener("click", (e) => {
          e.preventDefault();
          set(v);
          bs.forEach((o, k) => o.setAttribute("aria-checked", String(opts[k][0] === v)));
          sync();
        });
        b.setAttribute("aria-checked", String(v === value));
        return b;
      });
      g.append(...bs);
      return g;
    };
    const stripeRow = choice<Stripes>("stripes", "Stripes", [[null, "No stripes"], ["rows", "Striped rows"], ["columns", "Striped columns"]],
      stripes, (v) => { stripes = v; });
    const borderRow = choice<Borders>("borders", "Borders", [[null, "Grid"], ["outside", "Outside only"], ["rows", "Between rows"],
      ["columns", "Between columns"], ["none", "No borders"]], borders, (v) => { borders = v; });

    // the two stripe colours: squares with a picker each, and presets
    const squares = ([0, 1] as const).map((k) => {
      const b = el("button", "sq") as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("aria-label", k === 0 ? "First stripe color" : "Second stripe color");
      b.addEventListener("click", (e) => { e.preventDefault(); this.pickColor(b, (v) => { colors = k === 0 ? [v, colors[1]] : [colors[0], v]; themed = false; sync(); }); });
      return b;
    });
    const preset = el("select", "preset") as HTMLSelectElement;
    preset.setAttribute("aria-label", "Stripe colors");
    preset.append(new Option("Theme", "theme"), ...this.colors.presets.map((p, k) => new Option(p.name, String(k))), new Option("Custom", "custom"));
    preset.addEventListener("change", () => {
      if (preset.value === "theme") themed = true;
      else if (preset.value !== "custom") { colors = [...this.colors.presets[+preset.value].colors]; themed = false; }
      sync();
    });
    const colorRow = el("div", "colors");
    colorRow.append(...squares, preset);

    const msg = el("div", "msg");
    const ok = el("button", "lb apply") as HTMLButtonElement;
    ok.type = "button";
    ok.textContent = "Apply";
    const btns = el("div", "btns");
    btns.append(ok);
    const line = (label: string, content: HTMLElement) => {
      const r = el("div", "line");
      r.innerHTML = `<span class="lbl" aria-hidden="true">${label}</span>`;
      r.append(content);
      return r;
    };
    this.colorPop.hidden = true;
    this.props.replaceChildren(head, size, line("Stripes", stripeRow), colorRow, line("Borders", borderRow), msg, btns, this.colorPop);

    const sync = () => {
      colorRow.hidden = !stripes;
      squares.forEach((b, k) => {
        b.style.background = themed ? "" : colors[k];
        b.classList.toggle("theme", themed);
        b.title = themed ? "Theme color" : colors[k];
      });
      const k = this.colors.presets.findIndex((p) => p.colors[0] === colors[0] && p.colors[1] === colors[1]);
      preset.value = themed ? "theme" : k >= 0 ? String(k) : "custom";
    };
    sync();

    let confirmed = false;
    const apply = () => {
      const p: TableProps = {
        rows: clamp(+rows.i.value, 1, MAX_ROWS), cols: clamp(+cols.i.value, 1, MAX_COLS),
        stripes, colors: themed ? null : colors, borders,
      };
      const v = this.view();
      if (!confirmed && dropsText(v.state, p.rows, p.cols)) {
        confirmed = true;
        msg.textContent = "Cells with text would be removed. Apply again to remove them.";
        return;
      }
      this.close();
      setTableProps(p)(v.state, v.dispatch);
      v.focus();
    };
    for (const i of [rows.i, cols.i]) i.addEventListener("input", () => { confirmed = false; msg.textContent = ""; });
    this.props.onkeydown = (e) => {
      if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") { e.preventDefault(); apply(); }
    };
    ok.addEventListener("click", (e) => { e.preventDefault(); apply(); });
    this.overlay.open(this.props, at ?? this.cursorPoint());
    rows.i.focus();
    rows.i.select();
  }

  /** The colour picker of a stripe colour: the marker swatches, and the custom picker and
   *  recent colours when the palette allows them (as for the marker colour). */
  private pickColor(anchor: HTMLElement, set: (v: string) => void) {
    this.colorPop.replaceChildren();
    const done = (v: string) => { this.colorPop.hidden = true; set(v); };
    // the dialog has no tooltips of its own: the browser's show the labels
    const titled = <T extends HTMLElement>(b: T, label: string) => { b.title = label; return b; };
    this.colorPop.append(...this.colors.swatches.map((v) => titled(swatch(v, done), v)));
    if (this.colors.custom) {
      const picker = titled(customColor("pick", icon("pick", 16), (v) => { this.colors.addRecent(v); done(v); }), "Custom color…");
      this.colorPop.append(picker, ...this.colors.recent().map((v) => titled(swatch(v, done, "Recent: " + v), "Recent: " + v)));
    }
    this.colorPop.hidden = false;
    const p = this.props.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    this.colorPop.style.left = `${a.left - p.left}px`;
    this.colorPop.style.top = `${a.bottom - p.top + 4}px`;
  }

  private cursorPoint() {
    const view = this.view();
    const c = view.coordsAtPos(view.state.selection.head);
    return { x: c.left, y: c.bottom + 4 };
  }

  get isOpen() { return this.overlay.isOpen; }

  close() { this.overlay.close(); }

  destroy() { this.close(); }
}

/** The table the selection is in, with its position. */
export function tableAt(state: EditorState): { node: Node; pos: number } | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type === schema.nodes.table) return { node: $from.node(d), pos: $from.before(d) };
  }
  return null;
}
