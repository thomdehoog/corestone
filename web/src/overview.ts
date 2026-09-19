import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import type { Schema, Summary } from "./types";
import { kindIcon, relTime } from "./util";

// Artifact overview (design guide §7.4): every artifact matching the
// navigation context in a table whose columns come from the schemas.

@customElement("corestone-overview")
export class Overview extends LitElement {
  private unsub?: () => void;
  private s!: State;
  @state() private rows: Summary[] = [];
  @state() private total = 0;
  @state() private below = 0; // artifacts including subfolders, when the view shows the folder itself
  @state() private loading = false;
  @state() private error = "";
  @state() private schemas: Record<string, Schema> = {};
  @state() private menu = false;
  private key = "";
  private lastTick = -1;

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      this.s = s;
      const r = s.route;
      const key = JSON.stringify([r.folder, r.q, r.subtree, r.kind, r.type, s.refreshTick]);
      if (key !== this.key || s.refreshTick !== this.lastTick) {
        this.key = key;
        this.lastTick = s.refreshTick;
        this.load();
      }
      this.requestUpdate();
    });
    document.addEventListener("click", this.closeMenu);
  }
  override disconnectedCallback() { this.unsub?.(); document.removeEventListener("click", this.closeMenu); super.disconnectedCallback(); }
  private closeMenu = () => { if (this.menu) this.menu = false; };

  private async load() {
    const r = this.s.route;
    this.loading = true;
    this.error = "";
    try {
      const params: Record<string, string | number | boolean | undefined> = {
        q: r.q, path: r.folder, subtree: r.subtree || !!r.q || !!r.type, type: r.type,
        kind: r.kind || "entry,document", limit: 500, sort: r.q ? "" : "path",
      };
      const direct = !params.subtree;
      const [res, types, deep] = await Promise.all([
        api.search(params), api.types(r.folder),
        // the tree counts subfolders; say so here when the two numbers differ
        direct ? api.search({ ...params, subtree: true, limit: 1 }).catch(() => null) : null,
      ]);
      this.rows = res.artifacts;
      this.total = res.total;
      this.below = deep ? deep.total : res.total;
      const map: Record<string, Schema> = {};
      for (const t of types.types) map[t.type] = t;
      this.schemas = map;
    } catch (e) {
      this.error = String((e as Error).message ?? e);
      this.rows = [];
    } finally {
      this.loading = false;
    }
  }

  /** Columns: HID, title, type, workflow states, then schema-declared columns, then social/modified. */
  private columns(): { id: string; name: string }[] {
    const cols = new Map<string, string>();
    const wanted = new Set<string>();
    for (const row of this.rows) {
      const s = this.schemas[row.type];
      const pres = (s?.presentation?.columns as string[] | undefined) ?? [];
      for (const c of pres) wanted.add(c);
    }
    for (const id of wanted) {
      for (const s of Object.values(this.schemas)) {
        const f = s.fields?.find((x) => x.id === id);
        if (f) cols.set(id, f.name || id);
      }
      if (!cols.has(id)) cols.set(id, id);
    }
    return [...cols].map(([id, name]) => ({ id, name }));
  }

  private cell(row: Summary, id: string): TemplateResult | string {
    const v = row.fields?.[id];
    if (v == null) return "";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") return "{…}";
    return String(v);
  }

  private context(): string {
    const r = this.s.route;
    if (r.q) return `Search “${r.q}”`;
    if (r.type) return `${this.schemas[r.type]?.displayName ?? r.type} · all ${r.kind === "document" ? "documents" : "entries"}`;
    return r.folder ? r.folder.split("/").pop()! : "Repository";
  }

  override render() {
    if (!this.s) return nothing;
    const r = this.s.route;
    const cols = this.columns();
    const sel = r.guid;
    return html`
      <div class="toolbar">
        <div class="relative">
          <button class="btn primary" data-test="new" @click=${(e: Event) => { e.stopPropagation(); this.menu = !this.menu; }}>＋ New</button>
          ${this.menu ? this.newMenu() : nothing}
        </div>
        <span class="title">${this.context()}</span>
        <span class="hint">${this.loading ? "loading…" : html`${this.total} artifact${this.total === 1 ? "" : "s"}${r.subtree || r.q || r.type ? " incl. subfolders"
          : this.below > this.total ? html` here, <a href="#" data-test="show-subtree" @click=${(e: Event) => { e.preventDefault(); navigate({ subtree: true }); }}>${this.below} incl. subfolders</a>` : ""}`}</span>
        <span class="grow"></span>
        <div class="chips">
          ${[["", "Entries + Docs"], ["entry", "Entries"], ["document", "Documents"], ["link", "Links"], ["comment", "Comments"]].map(([k, name]) => html`
            <button class="chip ${r.kind === k ? "on" : ""}" @click=${() => navigate({ kind: k, type: k ? r.type : r.type })}>${name}</button>`)}
        </div>
        ${r.folder && !r.q && !r.type ? html`<button class="btn sm" data-test="move-folder" title="Move or rename this folder" @click=${this.moveFolder}>Move folder…</button>` : nothing}
        <button class="btn sm" title="Reload" aria-label="Reload overview" @click=${() => store.refresh()}>↻</button>
      </div>
      ${this.error ? html`<div class="notice error">${this.error}</div>` : nothing}
      <div class="table-wrap">
        ${!this.loading && !this.rows.length ? html`<div class="empty-state"><div class="big">Nothing here yet</div>
          ${r.q ? "No artifacts match your search." : html`Create your first artifact with <b>＋ New</b>, or pick another folder.`}</div>` : html`
        <table class="grid">
          <thead><tr><th>ID</th><th>Title</th><th>Type</th><th>State</th>${cols.map((c) => html`<th>${c.name}</th>`)}<th>Folder</th><th>Social</th><th>Modified</th></tr></thead>
          <tbody>${this.rows.map((row) => html`<tr class=${row.guid === sel ? "selected" : ""} data-guid=${row.guid} @click=${() => navigate({ guid: row.guid, folder: r.folder })}>
            <td>${row.hid ? html`<span class="hid">${row.hid}</span>` : html`<span class="muted mono">${row.guid.slice(0, 8)}</span>`}</td>
            <td title=${row.title ?? ""}>${kindIcon(row.kind)}${row.title || html`<span class="muted">${row.kind}</span>`}</td>
            <td>${this.schemas[row.type]?.displayName ?? row.type}</td>
            <td>${Object.entries(row.workflows ?? {}).map(([w, st]) => html`<span class="pill state" title=${w}>${st}</span> `)}</td>
            ${cols.map((c) => html`<td>${this.cell(row, c.id)}</td>`)}
            <td class="muted">${row.folder || "/"}</td>
            <td class="social" title="links · comments">⇄ ${row.links} · ✎ ${row.comments}</td>
            <td class="muted">${relTime(row.modifiedAt)}</td></tr>`)}</tbody>
        </table>`}
      </div>`;
  }

  private moveFolder = () => {
    const from = this.s.route.folder;
    store.prompt(`Move folder ${from}`, { text: "New location of the folder and everything below it.", value: from, confirmLabel: "Move", folder: true, ignore: from }).then((to) => {
      if (to === null || to.trim() === from) return;
      api.moveFolder(from, to.trim()).then((res) => {
        store.toast(`Moved ${res.moved} file${res.moved === 1 ? "" : "s"} to ${to.trim() || "/"}`, "success");
        store.refresh();
        navigate({ folder: to.trim().replace(/^\/+|\/+$/g, ""), guid: null });
      }).catch((e) => store.toast(e.message, "error"));
    });
  };

  private newMenu() {
    const r = this.s.route;
    const open = (opts: Record<string, unknown>) => { this.menu = false; store.set({ dialog: { kind: "new", folder: r.folder, ...opts } }); };
    return html`<div class="menu" @click=${(e: Event) => e.stopPropagation()}>
      <div class="group">in ${r.folder || "/"}</div>
      <button class="item" data-test="new-entry" @click=${() => open({ kinds: ["entry"] })}>Entry…</button>
      <button class="item" data-test="new-document" @click=${() => open({ kinds: ["document"] })}>Document…</button>
      <button class="item" data-test="new-link" @click=${() => open({ kinds: ["link"] })}>Link between artifacts…</button>
      <button class="item" data-test="new-comment" @click=${() => open({ kinds: ["comment"] })}>Comment…</button>
      <div class="group">any</div>
      <button class="item" data-test="new-any" @click=${() => open({})}>Choose a type…</button>
    </div>`;
  }
}
