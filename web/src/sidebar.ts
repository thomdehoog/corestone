import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import type { FolderInfo, Schema } from "./types";
import { displayName, kindPlural } from "./util";

// Repository navigation (design guide §7.3): search, subtree toggle, the
// folder hierarchy below the current folder, and artifacts grouped by schema type.

const FILTER_FROM = 15; // children of the current folder before a filter box appears

interface Node { info: FolderInfo; children: Node[] | null; open: boolean; pending?: boolean }

/** The tree counts everything below a folder; the tooltip says how much of it is in the folder itself. */
export function countTitle(f: FolderInfo): string {
  const below = f.artifacts - f.direct;
  const n = (k: number) => `${k} artifact${k === 1 ? "" : "s"}`;
  return below > 0 ? `${n(f.direct)} here, ${n(below)} in subfolders` : `${n(f.direct)} here`;
}

@customElement("corestone-sidebar")
export class Sidebar extends LitElement {
  private unsub?: () => void;
  private s!: State;
  @state() private root: Node = { info: { name: "Repository", path: "", artifacts: 0, direct: 0, hasConfig: false }, children: null, open: true };
  @state() private types: Schema[] = [];
  @state() private counts: Record<string, number> = {};
  @state() private q = "";
  private lastTick = -1;
  private lastFolder: string | null = null;
  private lastRouteQ: string | null = null;
  private timer = 0;
  @state() private filter = "";
  private rootSeq = 0;

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      const first = !this.s;
      this.s = s;
      if (first || s.refreshTick !== this.lastTick) {
        this.lastTick = s.refreshTick;
        this.reloadAll();
      }
      if (s.route.folder !== this.lastFolder) {
        this.lastFolder = s.route.folder;
        this.rootAt(s.route.folder);
        this.loadTypes(s.route.folder);
      }
      if (s.route.q !== this.lastRouteQ) { this.lastRouteQ = s.route.q; this.q = s.route.q; } // never wipe text being typed
      this.requestUpdate();
    });
  }
  override disconnectedCallback() { this.unsub?.(); super.disconnectedCallback(); }

  private async reloadAll() {
    await this.rootAt(this.s.route.folder);
    this.loadTypes(this.s.route.folder);
  }

  private async load(n: Node) {
    try {
      const t = await api.tree(n.info.path, false, 1);
      n.children = t.folders.map((f) => ({ info: f, children: null, open: false }));
    } catch {
      n.children = [];
    }
    this.requestUpdate();
  }

  // The tree is rooted at the folder being worked in: a large repository
  // shows only what lies below, the way up is the "up" row and the header
  // breadcrumb. Carets still expand in place without navigating.
  private async rootAt(folder: string) {
    const seq = ++this.rootSeq;
    const parts = folder.split("/").filter(Boolean);
    const name = parts[parts.length - 1] ?? "Repository";
    const root: Node = { info: { name, path: folder, artifacts: 0, direct: 0, hasConfig: false }, children: null, open: true };
    if (this.root.info.path !== folder) { this.root = root; this.filter = ""; } // show the new place at once
    const [parent] = await Promise.all([
      parts.length ? api.tree(parts.slice(0, -1).join("/"), false, 1).catch(() => null) : null,
      this.load(root),
    ]);
    if (seq !== this.rootSeq) return;
    const info = parent?.folders.find((f) => f.path === folder);
    if (info) root.info = info;
    // not in the repository yet (planned with "New folder"): a placeholder
    else if (parts.length && parent && !root.children?.length) root.pending = true;
    this.root = root;
  }

  private async loadTypes(folder: string) {
    try {
      const [t, counts] = await Promise.all([api.types(folder), api.search({ path: folder, subtree: true, kind: "entry,document", limit: 1 }).then(() => this.typeCounts(folder))]);
      this.types = t.types;
      this.counts = counts;
    } catch {
      /* keep old */
    }
  }

  private async typeCounts(folder: string): Promise<Record<string, number>> {
    const st = await api.status().catch(() => null);
    if (!folder && st?.stats) return st.stats.types;
    const r = await api.search({ path: folder, subtree: true, kind: "entry,document", limit: 5000 });
    const c: Record<string, number> = {};
    for (const a of r.artifacts) c[a.type] = (c[a.type] ?? 0) + 1;
    return c;
  }

  // Folders exist only through their content (Git tracks no empty
  // directories), so a new folder is a destination: it is shown as a
  // placeholder and becomes real with the first artifact saved there.
  private newFolder = async () => {
    const parent = this.s.route.folder;
    const name = await store.prompt("New folder", {
      text: `Subfolder of ${parent || "the repository root"}. It is created with the first artifact you save in it.`,
      placeholder: "name or sub/path", confirmLabel: "Open",
    });
    const rel = (name ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rel) return;
    navigate({ folder: parent ? `${parent}/${rel}` : rel, guid: null, type: "", q: "" });
  };

  private toggle(n: Node) {
    n.open = !n.open;
    if (n.open && !n.children) this.load(n);
    this.requestUpdate();
  }

  private node(n: Node, depth: number): TemplateResult {
    const r = this.s.route;
    const selected = r.folder === n.info.path && !r.type;
    const hasKids = n.children === null || n.children.length > 0;
    return html`<li>
      <div class="row ${selected ? "selected" : ""} ${n.pending ? "pending" : ""}" title=${n.pending ? "Not in the repository yet: created with the first artifact saved here" : ""} data-folder=${n.info.path} @click=${() => { navigate({ folder: n.info.path, guid: null, type: "", q: "" }); store.closeNavIfOverlay(); }}>
        <span class="caret ${hasKids ? "" : "empty"}" @click=${(e: Event) => { e.stopPropagation(); this.toggle(n); }}>${n.open ? "▾" : "▸"}</span>
        <span class="name">${depth === 0 ? html`<b>${n.info.name}</b>` : n.info.name}</span>
        ${n.info.hasConfig ? html`<span class="badge" title="has a .corestone metadata directory">.corestone</span>` : nothing}
        ${n.info.artifacts ? html`<span class="count" title=${countTitle(n.info)}>${n.info.artifacts}</span>` : nothing}
      </div>
      ${n.open && n.children?.length ? html`<ul>
        ${depth === 0 && n.children.length > FILTER_FROM ? html`<li><input class="tree-filter" type="search" data-test="folder-filter" placeholder="Filter ${n.children.length} folders…"
          .value=${this.filter} @input=${(e: Event) => (this.filter = (e.target as HTMLInputElement).value)} /></li>` : nothing}
        ${this.visible(n, depth).map((c) => this.node(c, depth + 1))}</ul>` : nothing}
    </li>`;
  }

  private visible(n: Node, depth: number): Node[] {
    const f = this.filter.trim().toLowerCase();
    return depth === 0 && f ? n.children!.filter((c) => c.info.name.toLowerCase().includes(f)) : n.children!;
  }

  private up() {
    const parts = this.s.route.folder.split("/").filter(Boolean);
    if (!parts.length) return nothing;
    const parent = parts.slice(0, -1).join("/");
    return html`<div class="row up" data-test="nav-up" title="Up to ${parent || "the repository root"}"
      @click=${() => navigate({ folder: parent, guid: null, type: "", q: "" })}>
      <span class="caret">↑</span><span class="name">${parts[parts.length - 2] ?? "Repository"}</span></div>`;
  }

  override render() {
    if (!this.s) return nothing;
    const r = this.s.route;
    const groups: Record<string, Schema[]> = {};
    for (const t of this.types) if (t.kind === "entry" || t.kind === "document") (groups[t.kind] ??= []).push(t);
    return html`
      <div class="nav-search">
        <input type="search" placeholder="Search (title, HID, text)…  /" .value=${this.q} data-test="search"
          @input=${(e: Event) => { this.q = (e.target as HTMLInputElement).value; window.clearTimeout(this.timer); this.timer = window.setTimeout(() => navigate({ q: this.q, guid: null }, true), 250); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { window.clearTimeout(this.timer); navigate({ q: this.q, guid: null }); } }} />
        <label class="nav-toggle"><span>Include subfolders (subtree)</span>
          <input type="checkbox" .checked=${r.subtree} data-test="subtree" @change=${(e: Event) => navigate({ subtree: (e.target as HTMLInputElement).checked })} /></label>
      </div>
      <div class="nav-scroll">
        <div class="nav-section"><div class="nav-title"><span>Folders</span>
          <button class="btn sm" data-test="new-folder" title="New subfolder of the current folder" @click=${this.newFolder}>＋</button></div>
          <div class="tree">${this.up()}</div>
          <ul class="tree">${this.node(this.root, 0)}</ul></div>
        <div class="nav-section"><div class="nav-title"><span>By type${r.folder ? html` <span class="muted">in ${r.folder}</span>` : nothing}</span></div>
          ${!this.types.length ? html`<div class="muted small" style="padding:4px 8px">No schemas visible here yet.</div>` : nothing}
          <ul class="tree">${(["entry", "document"] as const).filter((k) => groups[k]?.length).map((k) => html`<li>
            <div class="row"><span class="caret">▾</span><span class="name muted">${kindPlural[k]}</span></div>
            <ul>${groups[k].map((t) => html`<li><div class="row ${r.type === t.type ? "selected" : ""}" data-type=${t.type}
              @click=${() => { navigate({ type: t.type, kind: k, guid: null, subtree: true }); store.closeNavIfOverlay(); }}>
              <span class="caret empty">·</span><span class="name">${displayName(t, t.type)}</span>
              ${this.counts[t.type] ? html`<span class="count">${this.counts[t.type]}</span>` : nothing}</div></li>`)}</ul></li>`)}</ul></div>
      </div>`;
  }
}
