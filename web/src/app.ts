import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import { announceName, announceView } from "./ws";
import { folderCrumbs } from "./util";
import "./sidebar";
import "./overview";
import "./detail";
import "./document";
import "./dialogs";
import "./toast";

// Application shell (design guide §7.2): header, navigation sidebar, and
// the main workspace with the artifact overview above the detail view.

const DEFAULT_SPLIT = 38, MIN_SPLIT = 12, MAX_SPLIT = 85;

@customElement("corestone-app")
export class App extends LitElement {
  private unsub?: () => void;
  private s!: State;
  @state() private selectedKind: string | null = null;
  private lastGuid: string | null = null;
  private statusTimer = 0;
  @state() private split = Number(localStorage.getItem("corestone.split")) || DEFAULT_SPLIT; // overview height, % of the main area

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      this.s = s;
      if (s.route.guid !== this.lastGuid) {
        this.lastGuid = s.route.guid;
        this.selectedKind = null;
        if (s.route.guid) {
          announceView(s.route.guid);
          api.get(s.route.guid).then((v) => {
            if (store.state.route.guid !== v.meta.guid) return;
            this.selectedKind = v.meta.kind;
            // A deep link to an artifact shows it in the context of its folder.
            if (!store.state.route.folder && v.meta.folder && !store.state.route.q && !store.state.route.type) navigate({ folder: v.meta.folder }, true);
          }).catch(() => { this.selectedKind = "missing"; });
        } else announceView("");
      }
      this.requestUpdate();
    });
    this.pollStatus();
    window.addEventListener("keydown", this.onKey);
  }
  override disconnectedCallback() { this.unsub?.(); window.clearInterval(this.statusTimer); window.removeEventListener("keydown", this.onKey); super.disconnectedCallback(); }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "/" && !typing) { e.preventDefault(); this.querySelector<HTMLInputElement>("corestone-sidebar input[type=search]")?.focus(); }
    if (e.key === "n" && !typing && !this.s.dialog) { e.preventDefault(); store.set({ dialog: { kind: "new", folder: this.s.route.folder } }); }
    if (e.key === "Escape" && !typing && this.s.route.guid && !this.s.dialog) navigate({ guid: null, expanded: false });
  };

  private pollStatus() {
    const tick = () => api.status().then((st) => store.set({ status: st })).catch(() => store.set({ status: null }));
    tick();
    this.statusTimer = window.setInterval(tick, 15000);
  }

  private setSplit(pct: number, persist = true) {
    this.split = Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, pct));
    if (persist) localStorage.setItem("corestone.split", String(Math.round(this.split)));
  }

  // The divider between the overview and the selected artifact: drag, arrow
  // keys, or double-click to restore the default.
  private dragSplit = (e: PointerEvent) => {
    const bar = e.currentTarget as HTMLElement;
    const box = bar.parentElement!.getBoundingClientRect();
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    const move = (m: PointerEvent) => this.setSplit((100 * (m.clientY - box.top)) / box.height, false);
    const up = () => {
      bar.classList.remove("dragging");
      bar.removeEventListener("pointermove", move);
      this.setSplit(this.split);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up, { once: true });
    bar.addEventListener("pointercancel", up, { once: true });
    e.preventDefault();
  };

  private keySplit = (e: KeyboardEvent) => {
    const step = e.key === "ArrowUp" ? -4 : e.key === "ArrowDown" ? 4 : 0;
    if (!step) return;
    e.preventDefault();
    this.setSplit(this.split + step);
  };

  private setName = () => {
    store.prompt("Your name", { text: "Shown to others while you view or edit an artifact.", value: this.s.user, confirmLabel: "Save" })
      .then((n) => { if (n !== null && n.trim()) { store.setUser(n.trim()); announceName(n.trim()); } });
  };

  override render() {
    if (!this.s) return nothing;
    const { route, status, connected, navCollapsed } = this.s;
    const p = status?.projection;
    const health = !status ? "bad" : p?.maintenance ? "warn" : status.inSync ? "ok" : "warn";
    const healthText = !status ? "server unreachable" : p?.maintenance ? `maintenance: ${p.phase || p.reason || ""} ${p.total ? `${p.progress}/${p.total}` : ""}` : status.inSync ? "in sync" : "syncing…";
    const mainClass = route.guid && this.selectedKind === "document" ? "document" : route.expanded ? "expanded" : "";
    return html`<div class="shell ${navCollapsed ? "nav-collapsed" : ""}">
      <header class="header">
        <button class="btn sm icon" title="Toggle navigation" aria-label="Toggle navigation" @click=${() => store.toggleNav()}>☰</button>
        <a class="brand" href="/" @click=${(e: Event) => { e.preventDefault(); navigate({ folder: "", guid: null, q: "", type: "", kind: "" }); }}><span class="logo"></span>Corestone</a>
        <nav class="crumbs">${folderCrumbs(route.folder).map((c, i) => html`${i ? html`<span>/</span>` : nothing}<a href="#" @click=${(e: Event) => { e.preventDefault(); navigate({ folder: c.path, guid: null, type: "" }); }}>${c.name}</a>`)}</nav>
        <span class="spacer"></span>
        ${p?.maintenance && p.total ? html`<div class="progress" title=${p.phase ?? ""}><div style=${`width:${Math.round((100 * p.progress) / Math.max(1, p.total))}%`}></div></div>` : nothing}
        <span class="status" title=${status ? `head ${status.head.slice(0, 8)} · projection ${p?.processedHash.slice(0, 8) ?? ""}` : ""}><span class="dot ${health}"></span>${healthText}<span class="dot ${connected ? "ok" : "bad"}" data-test="session" title=${connected ? "session connected" : "session disconnected"}></span></span>
        <button class="btn sm" title="Rebuild projection from Git" @click=${() => api.reindex().then(() => store.toast("Reindex started", "info")).catch((e) => store.toast(e.message, "error"))}>Reindex</button>
        <button class="btn sm" title="Set your name" @click=${this.setName}>${this.s.user || "anonymous"}</button>
      </header>
      <corestone-sidebar></corestone-sidebar>
      <div class="nav-scrim" @click=${() => store.toggleNav()}></div>
      <div class="main ${mainClass}" style=${`--split:${this.split}%`}>
        <corestone-overview></corestone-overview>
        <div class="splitter" data-test="splitter" role="separator" aria-orientation="horizontal" tabindex="0" title="Drag to resize; double-click to reset"
          aria-valuemin=${MIN_SPLIT} aria-valuemax=${MAX_SPLIT} aria-valuenow=${Math.round(this.split)}
          @pointerdown=${this.dragSplit} @keydown=${this.keySplit} @dblclick=${() => this.setSplit(DEFAULT_SPLIT)}></div>
        ${route.guid ? (this.selectedKind === "document" ? html`<corestone-document .guid=${route.guid}></corestone-document>` : html`<corestone-detail .guid=${route.guid}></corestone-detail>`)
          : html`<div class="empty-state" style="display:grid;place-items:center"><div><div class="big">Select an artifact</div>Pick a row above, search with <kbd>/</kbd>, or create one with <kbd>n</kbd>.</div></div>`}
      </div>
    </div>
    <corestone-dialogs></corestone-dialogs>
    <corestone-toasts></corestone-toasts>`;
  }
}
