import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api, ApiError } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import type { CommentView, LogEntry, OverlayView, Relationships, Schema, View, WorkflowEval } from "./types";
import { announceEdit } from "./ws";
import { deepEqual, fmtSize, fmtTime, kindIcon, label, relTime } from "./util";
import "./fields";

// Entry detail view (design guide §7.5): one scrollable page with every
// section the effective schema implies, quick links to sections, and an
// optimistic-concurrency save (ETag / If-Match).

const SECTIONS = ["general", "fields", "workflows", "relationships", "comments", "attachments", "overlay", "history", "metadata"] as const;

@customElement("corestone-detail")
export class Detail extends LitElement {
  @property() guid = "";
  private unsub?: () => void;
  private s!: State;
  @state() private view: View | null = null;
  @state() private schema: Schema | null = null;
  @state() private workflows: WorkflowEval[] = [];
  @state() private rel: Relationships | null = null;
  @state() private comments: CommentView[] = [];
  @state() private overlay: OverlayView | null = null;
  @state() private history: LogEntry[] = [];
  @state() private draft: { title: string; hid: string; fields: Record<string, unknown> } | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private loading = true;
  @state() private replyTo: string | null = null;
  @state() private commentText = "";
  @state() private showDiagram: string | null = null;
  private lastTick = -1;
  private editing = false;
  private loadSeq = 0;
  private softInFlight = false;
  private softPending = false;
  private warnedEtag = "";

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      this.s = s;
      if (s.refreshTick !== this.lastTick) {
        this.lastTick = s.refreshTick;
        if (this.view) this.reload(true);
      }
      this.requestUpdate();
    });
  }
  override disconnectedCallback() { this.unsub?.(); if (this.editing) announceEdit(this.guid, false); super.disconnectedCallback(); }
  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("guid") && this.guid) { this.draft = null; this.reload(false); }
  }

  private get dirty(): boolean {
    if (!this.draft || !this.view) return false;
    const d = this.view.data as Record<string, unknown>;
    return this.draft.title !== (d.title ?? "") || this.draft.hid !== (d.hid ?? "") || !deepEqual(this.draft.fields, d.fields ?? {});
  }

  private async reload(soft: boolean) {
    // A navigation (hard load) supersedes everything in flight. Soft
    // refreshes (repository events) are coalesced: under a stream of
    // events one refresh runs at a time and one more is queued, so the
    // view always catches up instead of being superseded forever.
    if (soft) {
      if (this.softInFlight) { this.softPending = true; return; }
      this.softInFlight = true;
    }
    const seq = soft ? this.loadSeq : ++this.loadSeq;
    const guid = this.guid;
    const stale = () => seq !== this.loadSeq || guid !== this.guid;
    try {
      await this.load(soft, guid, stale);
    } finally {
      if (soft) {
        this.softInFlight = false;
        if (this.softPending && !stale()) { this.softPending = false; void this.reload(true); }
        else this.softPending = false;
      }
    }
  }

  private async load(soft: boolean, guid: string, stale: () => boolean) {
    if (!soft) { this.loading = true; this.view = null; this.draft = null; this.schema = null; this.overlay = null; this.rel = null; this.comments = []; this.history = []; this.workflows = []; }
    this.error = "";
    try {
      const view = await api.get(guid);
      if (stale()) return;
      const [schema, wf, rel, comments, history, overlay] = await Promise.all([
        api.schemaOf(guid).catch(() => ({ schema: null })),
        api.workflows(guid).catch(() => ({ workflows: [] })),
        api.relationships(guid).catch(() => null),
        api.comments(guid).catch(() => ({ comments: [] })),
        api.history(guid).catch(() => ({ history: [] })),
        view.meta.kind === "entry" ? api.overlay(guid).catch(() => null) : Promise.resolve(null),
      ]);
      if (stale()) return;
      // Judge the draft against the view it was made from, after every
      // await: typing that happened during the fetches must survive.
      const wasDirty = this.dirty;
      if (soft && wasDirty && view.etag !== this.view?.etag) {
        // Keep the draft and the ETag we started from: saving will be
        // rejected (412) instead of silently overwriting the other change.
        if (this.warnedEtag !== view.etag) {
          this.warnedEtag = view.etag;
          store.toast("This artifact was changed by someone else while you were editing.", "error", { label: "Reload", run: () => { this.draft = null; this.reload(false); } });
        }
        this.loading = false;
        return;
      }
      this.view = view;
      this.schema = schema.schema;
      this.workflows = wf.workflows;
      this.rel = rel;
      this.comments = comments.comments;
      this.history = history.history;
      this.overlay = overlay;
      if (!this.draft || !wasDirty) this.resetDraft(); // an untouched draft follows the new version
    } catch (e) {
      if (stale()) return;
      this.error = e instanceof ApiError ? e.message : String(e);
      if (!soft) this.view = null;
    } finally {
      if (!stale()) this.loading = false;
    }
  }

  private resetDraft() {
    const d = this.view!.data as Record<string, unknown>;
    this.draft = { title: String(d.title ?? ""), hid: String(d.hid ?? ""), fields: structuredClone((d.fields as Record<string, unknown>) ?? {}) };
    if (this.editing) { announceEdit(this.guid, false); this.editing = false; }
  }

  private touched() {
    if (!this.editing) { this.editing = true; announceEdit(this.guid, true); }
  }

  private async save() {
    if (!this.view || !this.draft || this.busy) return;
    this.busy = true;
    this.error = "";
    const d = this.view.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (this.draft.title !== (d.title ?? "")) patch.title = this.draft.title;
    if (this.draft.hid !== (d.hid ?? "")) patch.hid = this.draft.hid || null;
    const fields: Record<string, unknown> = {};
    const old = (d.fields as Record<string, unknown>) ?? {};
    for (const [k, v] of Object.entries(this.draft.fields)) if (!deepEqual(v, old[k])) fields[k] = v === undefined ? null : v;
    for (const k of Object.keys(old)) if (!(k in this.draft.fields)) fields[k] = null;
    if (Object.keys(fields).length) patch.fields = fields;
    try {
      this.view = await api.update(this.guid, patch, this.view.etag);
      store.toast("Saved", "success");
      this.resetDraft();
      store.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        this.error = "Someone else modified this artifact in the meantime. Reload to see their changes; your edits stay in the form until you do.";
      } else {
        this.error = e instanceof ApiError ? e.message : String(e);
      }
    } finally {
      this.busy = false;
    }
  }

  private async transition(wf: string, to: string) {
    try {
      this.view = await api.transition(this.guid, wf, to, this.view?.etag);
      store.toast(`${wf}: now ${this.view.meta.workflows?.[wf] ?? to}`, "success");
      this.reload(true);
      store.refresh();
    } catch (e) {
      store.toast(e instanceof ApiError ? e.message : String(e), "error");
    }
  }

  private async deleteArtifact() {
    const v = this.view!;
    store.set({ dialog: { kind: "confirm", title: `Delete ${label(v.meta)}?`, danger: true, confirmLabel: "Delete",
      text: `The artifact, its ${v.meta.links} link(s), ${v.meta.comments} comment(s) and ${v.attachments?.length ?? 0} attachment(s) are removed in one commit. History stays in Git.`,
      onConfirm: async () => {
        try {
          await api.remove(this.guid, v.etag);
          store.toast("Deleted", "success");
          store.refresh();
          navigate({ guid: null });
        } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
      } } });
  }

  private async addComment() {
    if (!this.commentText.trim()) return;
    try {
      await api.create("comments", { subject: this.guid, parent: this.replyTo ?? undefined, text: this.commentText, author: this.s.user });
      this.commentText = "";
      this.replyTo = null;
      this.reload(true);
      store.refresh();
    } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
  }

  private addLink(asSource: boolean, type: string, types?: string[]) {
    store.set({ picker: { kind: "pick", title: asSource ? `${type}: choose target` : `${type}: choose source`, types, exclude: this.guid, kinds: ["entry", "document"],
      onPick: async (other: { guid: string }) => {
        try {
          await api.create("links", asSource ? { type, source: this.guid, target: other.guid } : { type, source: other.guid, target: this.guid });
          store.toast("Link created", "success");
          this.reload(true);
          store.refresh();
        } catch (e) { store.toast(e instanceof ApiError ? e.message : String(e), "error"); }
      } } });
  }

  private async upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      await api.uploadFile(this.guid, file.name, file);
      store.toast(`Attached ${file.name}`, "success");
      this.reload(true);
    } catch (err) { store.toast(err instanceof ApiError ? err.message : String(err), "error"); }
    input.value = "";
  }

  private move() {
    store.prompt("Move artifact", { text: "Target folder; leave empty for the repository root.", value: this.view?.meta.folder ?? "", confirmLabel: "Move", folder: true }).then((folder) => {
      if (folder === null) return;
      api.move(this.guid, folder).then((v) => { this.view = v; store.toast(`Moved to ${folder || "/"}`, "success"); store.refresh(); navigate({ folder }); this.reload(true); })
        .catch((e) => store.toast(e instanceof ApiError ? e.message : String(e), "error"));
    });
  }

  private createVariant() {
    const v = this.view!;
    store.set({ dialog: { kind: "new", kinds: ["entry"], type: v.meta.type, folder: v.meta.folder, baseGuid: this.guid } });
    // the new dialog reads baseGuid via a small hook below
    window.setTimeout(() => {
      const dlg = document.querySelector("corestone-new-dialog") as (HTMLElement & { base: string; baseLabel: string }) | null;
      if (dlg) { dlg.base = this.guid; dlg.baseLabel = label(v.meta); }
    }, 50);
  }

  override render() {
    if (!this.view && (this.loading || !this.error)) return html`<div class="empty-state">Loading…</div>`;
    if (!this.view) return html`<div class="empty-state"><div class="big">Artifact not available</div>${this.error}<br><button class="btn" @click=${() => navigate({ guid: null })}>Back</button></div>`;
    if (!this.draft) return html`<div class="empty-state">Loading…</div>`;
    const v = this.view;
    const r = this.s.route;
    const presence = this.s.presence[this.guid];
    const others = presence ? [...presence.editors].filter((n) => n !== this.s.user) : [];
    const active = r.tab || "general";
    return html`
      <div class="detail-head">
        ${kindIcon(v.meta.kind)}
        ${v.meta.hid ? html`<span class="hid">${v.meta.hid}</span>` : nothing}
        <h2>${this.draft?.title || v.meta.title || html`<span class="muted">untitled ${v.meta.kind}</span>`}</h2>
        ${others.length ? html`<span class="presence" title="concurrent editing">✎ ${others.join(", ")} editing</span>` : nothing}
        <span class="meta"><span>${this.schema?.displayName ?? v.meta.type}</span><span>·</span><span>${v.meta.folder || "/"}</span><span>·</span><span title=${v.meta.modifiedAt ?? ""}>${relTime(v.meta.modifiedAt)}</span></span>
        <button class="btn sm" title=${r.expanded ? "Restore layout" : "Expand detail"} @click=${() => navigate({ expanded: !r.expanded })}>${r.expanded ? "⤡" : "⤢"}</button>
        <button class="btn sm" @click=${this.move}>Move…</button>
        <button class="btn sm danger" data-test="delete" @click=${this.deleteArtifact}>Delete</button>
        <button class="btn sm icon" title="Close" aria-label="Close detail view" @click=${() => navigate({ guid: null, tab: "", expanded: false })}>✕</button>
      </div>
      <div class="detail-body">
        <nav class="quicklinks">${SECTIONS.filter((s) => this.hasSection(s)).map((s) => html`<a href="#" class=${active === s ? "active" : ""} @click=${(e: Event) => { e.preventDefault(); navigate({ tab: s }, true); this.querySelector(`#sec-${s}`)?.scrollIntoView({ block: "start" }); }}>${this.sectionName(s)}<span class="n">${this.sectionCount(s)}</span></a>`)}</nav>
        <div class="sections">
          ${this.error ? html`<div class="notice error" role="alert">${this.error} ${this.error.includes("Reload") ? html`<button class="btn sm" @click=${() => { this.draft = null; this.reload(false); }}>Reload</button>` : nothing}</div>` : nothing}
          ${this.general()}
          ${this.fieldsSection()}
          ${this.hasSection("workflows") ? this.workflowSection() : nothing}
          ${this.relSection()}
          ${this.commentSection()}
          ${v.meta.kind === "entry" || v.meta.kind === "document" ? this.attachmentSection() : nothing}
          ${this.overlay ? this.overlaySection() : nothing}
          ${this.historySection()}
          ${this.metadataSection()}
        </div>
      </div>
      ${this.dirty ? html`<div class="savebar"><span class="dirty">Unsaved changes</span>
        <button class="btn" @click=${() => this.resetDraft()}>Discard</button>
        <button class="btn primary" data-test="save" ?disabled=${this.busy} @click=${this.save}>${this.busy ? "Saving…" : "Save"}</button></div>` : nothing}`;
  }

  private hasSection(s: string): boolean {
    const k = this.view?.meta.kind;
    switch (s) {
      case "workflows": return this.workflows.length > 0;
      case "attachments": return k === "entry" || k === "document";
      case "overlay": return !!this.overlay;
      default: return true;
    }
  }
  private sectionName(s: string) { return { general: "General", fields: "Fields", workflows: "Workflows", relationships: "Relationships", comments: "Comments", attachments: "Attachments", overlay: "Overlay", history: "History", metadata: "Additional metadata" }[s] ?? s; }
  private sectionCount(s: string): string {
    switch (s) {
      case "fields": return String((this.schema?.fields ?? []).length || Object.keys(this.draft?.fields ?? {}).length || "");
      case "relationships": return String((this.rel?.incoming.length ?? 0) + (this.rel?.outgoing.length ?? 0) || "");
      case "comments": return String(this.comments.length || "");
      case "attachments": return String(this.view?.attachments?.length || "");
      case "history": return String(this.history.length || "");
      case "overlay": return String(((this.overlay?.chain.length ?? 1) - 1) || "");
      default: return "";
    }
  }

  private general() {
    const v = this.view!;
    const d = this.draft!;
    return html`<section class="section" id="sec-general"><h3>General</h3>
      <div class="field"><label for="d-title">Title</label><div class="value"><input id="d-title" type="text" data-test="title" .value=${d.title} @focus=${this.touched}
        @input=${(e: Event) => { this.draft = { ...d, title: (e.target as HTMLInputElement).value }; }} /></div></div>
      <div class="field"><label for="d-hid">HID</label><div class="value"><input id="d-hid" type="text" .value=${d.hid} placeholder="none" @focus=${this.touched}
        @input=${(e: Event) => { this.draft = { ...d, hid: (e.target as HTMLInputElement).value }; }} /><div class="help">Human-readable identifier; must be unique. Previous HIDs stay resolvable through history.</div></div></div>
      <dl class="kv">
        <dt>Type</dt><dd>${this.schema?.displayName ?? v.meta.type} <span class="muted">(${v.meta.type}${this.schema ? "" : ", no schema"})</span></dd>
        <dt>Kind</dt><dd>${v.meta.kind}</dd>
        <dt>Folder</dt><dd><a href=${"/folder/" + v.meta.folder} @click=${(e: Event) => { e.preventDefault(); navigate({ folder: v.meta.folder, guid: null }); }}>${v.meta.folder || "/"}</a></dd>
        <dt>GUID</dt><dd class="mono">${v.meta.guid}</dd>
        <dt>ETag</dt><dd class="mono">${v.etag.slice(0, 12)}</dd>
        <dt>Created</dt><dd>${fmtTime(v.meta.createdAt)}</dd>
        <dt>Modified</dt><dd>${fmtTime(v.meta.modifiedAt)}</dd>
        ${this.schema?.sources?.length ? html`<dt>Schema from</dt><dd>${this.schema.sources.map((s) => s || "/").join(" → ")}</dd>` : nothing}
      </dl></section>`;
  }

  private fieldsSection() {
    const d = this.draft!;
    const fields = (this.schema?.fields ?? []).filter((f) => f.type !== "workflow");
    const known = new Set(fields.map((f) => f.id));
    const extra = Object.keys(d.fields).filter((k) => !known.has(k));
    return html`<section class="section" id="sec-fields"><h3>Fields</h3>
      ${!fields.length && !extra.length ? html`<div class="muted small">No fields defined for this type. Add a schema to describe it.</div>` : nothing}
      ${fields.map((f) => html`<corestone-field .field=${f} .value=${d.fields[f.id]} .attachments=${this.view?.attachments ?? []}
        .inheritedFrom=${this.inheritedFrom(f.id)} @focusin=${this.touched}
        @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; this.draft = { ...d, fields: next }; this.touched(); }}
        @open-artifact=${(e: CustomEvent) => navigate({ guid: e.detail })}></corestone-field>`)}
      ${extra.map((k) => html`<corestone-field .field=${{ id: k, name: k + " (unschematized)", type: typeof d.fields[k] === "object" ? "json" : typeof d.fields[k] === "boolean" ? "boolean" : "text" }} .value=${d.fields[k]}
        @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; this.draft = { ...d, fields: next }; this.touched(); }}></corestone-field>`)}
    </section>`;
  }

  private inheritedFrom(fieldId: string): string | null {
    if (!this.overlay || this.draft!.fields[fieldId] !== undefined) return null;
    const origin = this.overlay.origin[fieldId];
    return origin && origin !== this.guid ? origin : null;
  }

  private workflowSection() {
    return html`<section class="section" id="sec-workflows"><h3>Workflows</h3>
      ${this.workflows.map((w) => html`<div class="workflow" data-workflow=${w.id}>
        <span class="name">${w.definition.name || w.id}</span>
        <span class="pill state">${w.state}</span>
        <select data-test=${"transition-" + w.id} @change=${(e: Event) => { const to = (e.target as HTMLSelectElement).value; if (to) this.transition(w.id, to); (e.target as HTMLSelectElement).value = ""; }}>
          <option value="">${w.available.length ? "Transition to…" : "No transitions available"}</option>
          ${w.available.map((t) => html`<option value=${t.id || t.to}>${t.name || t.id || "→ " + t.to}</option>`)}
        </select>
        <button class="btn sm" @click=${() => (this.showDiagram = this.showDiagram === w.id ? null : w.id)}>? diagram</button>
        ${this.showDiagram === w.id ? html`<div class="wf-diagram" style="flex-basis:100%">
          ${w.definition.states.map((s) => html`<span class="wf-state ${s.id === w.state ? "current" : ""}" style=${s.color ? `border-color:${s.color}` : ""}>${s.name || s.id}</span>`)}
          <span class="wf-edge">·</span>
          ${w.definition.transitions.map((t) => html`<span class="wf-edge">${t.from.join("|")} → ${t.to}${t.name ? ` (${t.name})` : ""}</span>`)}
          <span class="muted small">defined in ${w.definition.scope || "/"}</span></div>` : nothing}
      </div>`)}</section>`;
  }

  private relSection() {
    const rel = this.rel;
    const row = (lv: { link: { type: string; guid: string }; other: { guid: string; title?: string; hid?: string; kind: string } }, dir: "in" | "out") => html`<div class="link-row">
      <span class="type">${lv.link.type}</span><span class="arrow">${dir === "in" ? "←" : "→"}</span>
      ${kindIcon(lv.other.kind as never)}${lv.other.hid ? html`<span class="hid">${lv.other.hid}</span>` : nothing}
      <a href=${"/artifact/" + lv.other.guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid: lv.other.guid }); }}>${label(lv.other as never)}</a>
      <span class="grow"></span>
      <button class="btn sm" title="Remove link" aria-label="Remove link" @click=${() => api.remove(lv.link.guid).then(() => { this.reload(true); store.refresh(); }).catch((e) => store.toast(e.message, "error"))}>✕</button></div>`;
    return html`<section class="section" id="sec-relationships"><h3>Relationships <span class="actions">
        ${rel?.allowedAsSource.map((s) => html`<button class="btn sm" @click=${() => this.addLink(true, s.type, s.targetTypes)}>＋ ${s.displayName || s.type} →</button>`)}
        ${rel?.allowedAsTarget.filter((s) => !rel.allowedAsSource.some((x) => x.type === s.type)).map((s) => html`<button class="btn sm" @click=${() => this.addLink(false, s.type, s.sourceTypes)}>← ${s.displayName || s.type}</button>`)}
        <button class="btn sm" @click=${() => store.prompt("Link type", { text: "Any link type; undefined types have no endpoint rules.", value: "related", confirmLabel: "Choose target…" }).then((t) => { if (t?.trim()) this.addLink(true, t.trim()); })}>＋ other…</button></span></h3>
      ${!rel || (!rel.incoming.length && !rel.outgoing.length) ? html`<div class="muted small">No links yet.</div>` : html`<div class="links-list">
        ${rel.outgoing.map((l) => row(l as never, "out"))}${rel.incoming.map((l) => row(l as never, "in"))}</div>`}</section>`;
  }

  private commentSection() {
    const byParent = new Map<string, CommentView[]>();
    const known = new Set(this.comments.map((c) => c.meta.guid));
    for (const c of this.comments) {
      let p = String(c.data?.parent ?? "");
      if (p && (!known.has(p) || p === c.meta.guid)) p = ""; // orphaned reply: show at the root
      byParent.set(p, [...(byParent.get(p) ?? []), c]);
    }
    const seen = new Set<string>();
    const render = (parent: string, depth: number): TemplateResult[] => (byParent.get(parent) ?? []).filter((c) => !seen.has(c.meta.guid) && seen.add(c.meta.guid) && depth < 50).map((c) => html`<div class="comment ${depth ? "reply" : ""}" data-comment=${c.meta.guid}>
      <div class="who"><b>${c.meta.author || "anonymous"}</b> · ${fmtTime(c.meta.created)} ${c.data?.type && c.data.type !== "comment" ? html`<span class="pill">${String(c.data.type)}</span>` : nothing}
        <a href="#" @click=${(e: Event) => { e.preventDefault(); this.replyTo = c.meta.guid; this.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>reply</a></div>
      <div class="text">${String(c.data?.text ?? "")}</div>
      ${render(c.meta.guid, depth + 1)}</div>`);
    return html`<section class="section" id="sec-comments"><h3>Comments</h3>
      ${!this.comments.length ? html`<div class="muted small">No comments yet.</div>` : render("", 0)}
      <div class="inline-form">
        <textarea id="comment-text" data-test="comment-text" placeholder=${this.replyTo ? "Reply…" : "Write a comment…"} .value=${this.commentText} @input=${(e: Event) => (this.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn primary sm" data-test="comment-send" @click=${this.addComment}>Post</button>
          ${this.replyTo ? html`<button class="btn sm" @click=${() => (this.replyTo = null)}>cancel reply</button>` : nothing}
        </div></div></section>`;
  }

  private attachmentSection() {
    const att = this.view?.attachments ?? [];
    return html`<section class="section" id="sec-attachments"><h3>Attachments <span class="actions"><label class="btn sm">＋ Upload<input type="file" hidden @change=${this.upload} /></label></span></h3>
      ${!att.length ? html`<div class="muted small">Files stored in the artifact's GUID directory appear here.</div>` : nothing}
      ${att.map((a) => html`<div class="attach-row"><a href=${api.fileUrl(this.guid, a.name)} target="_blank" rel="noopener">${a.name}</a><span class="size">${fmtSize(a.size)}</span>
        <button class="btn sm" title="Remove attachment" aria-label="Remove attachment" @click=${() => api.deleteFile(this.guid, a.name).then(() => this.reload(true)).catch((e) => store.toast(e.message, "error"))}>✕</button></div>`)}
    </section>`;
  }

  private overlaySection() {
    const ov = this.overlay!;
    return html`<section class="section" id="sec-overlay"><h3>Overlay composition <span class="actions"><button class="btn sm" @click=${this.createVariant}>＋ Create variant of this entry</button></span></h3>
      ${ov.chain.length > 1 ? html`<div class="chain">${ov.chain.map((lvl, i) => html`
        ${i ? html`<span class="arrow">→ overrides</span>` : nothing}
        <div class="node ${lvl.guid === this.guid ? "self" : ""}">
          ${lvl.guid === this.guid ? html`<b>this entry</b>` : html`<a href=${"/artifact/" + lvl.guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid: lvl.guid }); }}>${lvl.hid || lvl.title || lvl.guid.slice(0, 8)}</a>`}
          <small>${lvl.fields.length ? "sets " + lvl.fields.join(", ") : "sets nothing"}</small></div>`)}</div>
        <dl class="kv" style="margin-top:10px"><dt>Effective fields</dt><dd>${Object.entries(ov.fields).map(([k, v]) => html`<div><b>${k}</b>: ${typeof v === "object" ? JSON.stringify(v) : String(v)} <span class="muted small">from ${ov.origin[k] === this.guid ? "this entry" : ov.origin[k].slice(0, 8)}</span></div>`)}</dd></dl>` : html`<div class="muted small">This entry has no base.</div>`}
      ${ov.overlays.length ? html`<h4 class="small muted" style="margin-top:10px">Variants deriving from this entry</h4>${ov.overlays.map((o) => html`<div><a href=${"/artifact/" + o.guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid: o.guid }); }}>${o.hid ? o.hid + " " : ""}${o.title}</a></div>`)}` : nothing}
    </section>`;
  }

  private historySection() {
    return html`<section class="section" id="sec-history"><h3>History</h3>
      ${this.history.map((h) => html`<div class="history-row"><span class="when" title=${h.time}>${fmtTime(h.time)}</span><span>${h.subject}${h.trailers?.["Corestone-Op"] ? html` <span class="pill">${h.trailers["Corestone-Op"]}</span>` : nothing}</span><span class="mono muted">${h.sha.slice(0, 8)}</span></div>`)}
      ${!this.history.length ? html`<div class="muted small">No history yet.</div>` : nothing}</section>`;
  }

  private metadataSection() {
    const d = { ...(this.view!.data as Record<string, unknown>) };
    for (const k of ["guid", "kind", "type", "title", "hid", "fields", "workflows", "content"]) delete d[k];
    return html`<section class="section" id="sec-metadata"><h3>Additional metadata</h3>
      ${Object.keys(d).length ? html`<pre class="json">${JSON.stringify(d, null, 2)}</pre>` : html`<div class="muted small">No extra properties. Tools may add their own; they are preserved on save.</div>`}
      <div class="help">Stored at <code>${this.view!.meta.path}</code></div></section>`;
  }
}
