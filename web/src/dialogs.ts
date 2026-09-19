import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { api, ApiError } from "./api";
import { navigate } from "./router";
import { store, type Dialog, type State } from "./store";
import type { Kind, Schema, Summary } from "./types";
import { collectionOf, displayName, kindIcon, kindLabel, kindPlural, label } from "./util";
import "./fields";
import "./folder-field";

// Modal dialogs: the "+ New" flow (choose a type → empty schema-generated
// form → create), the artifact picker, and confirmations.

@customElement("corestone-dialogs")
export class Dialogs extends LitElement {
  private unsub?: () => void;
  private s!: State;
  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => { this.s = s; this.requestUpdate(); });
    window.addEventListener("keydown", this.onKey);
  }
  override disconnectedCallback() { this.unsub?.(); window.removeEventListener("keydown", this.onKey); super.disconnectedCallback(); }
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (this.s?.picker) { const c = this.s.picker.onCancel as (() => void) | undefined; store.set({ picker: null }); c?.(); }
    else if (this.s?.dialog) this.dismiss();
  };

  /** Closes the current dialog and tells it that nothing was chosen. */
  private dismiss() {
    const d = this.s?.dialog;
    store.set({ dialog: null });
    (d?.onCancel as (() => void) | undefined)?.();
  }

  override updated() {
    // A freshly opened prompt gets the keyboard, with its suggestion selected.
    const input = this.querySelector<HTMLInputElement>(".dialog input[data-test=prompt]");
    if (input && document.activeElement !== input && !this.querySelector(".picker-layer")) { input.focus(); input.select(); }
  }

  override render() {
    const d = this.s?.dialog;
    const p = this.s?.picker;
    let body;
    switch (d?.kind) {
      case "new": body = html`<corestone-new-dialog .dialog=${d}></corestone-new-dialog>`; break;
      case "confirm": body = this.confirm(d); break;
      case "prompt": body = this.prompt(d); break;
      default: body = nothing;
    }
    return html`${d ? html`<div class="backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.dismiss(); }}>
        <div class="dialog ${d.kind === "prompt" ? "prompt" : ""}" role="dialog" aria-modal="true">${body}</div></div>` : nothing}
      ${p ? html`<div class="backdrop picker-layer" @click=${(e: Event) => { if (e.target === e.currentTarget) { const c = p.onCancel as (() => void) | undefined; store.set({ picker: null }); c?.(); } }}>
        <div class="dialog" role="dialog" aria-modal="true"><corestone-picker .dialog=${p}></corestone-picker></div></div>` : nothing}`;
  }

  private prompt(d: Dialog) {
    const submit = (e: Event) => {
      e.preventDefault();
      const value = this.querySelector<HTMLInputElement>(".dialog input[data-test=prompt]")?.value ?? "";
      store.set({ dialog: null });
      (d.onSubmit as (v: string) => void)(value);
    };
    return html`<h2>${d.title as string}</h2>
      ${d.text ? html`<p class="hint">${d.text as string}</p>` : nothing}
      <form class="prompt-form" @submit=${submit}>
        ${d.folder
          ? html`<corestone-folder-field test="prompt" .value=${(d.value as string) ?? ""} .ignore=${(d.ignore as string) ?? ""}></corestone-folder-field>`
          : html`<input type="text" data-test="prompt" .value=${(d.value as string) ?? ""} placeholder=${(d.placeholder as string) ?? ""} aria-label=${d.title as string}>`}
        <div class="foot"><button type="button" class="btn" @click=${() => this.dismiss()}>Cancel</button>
        <button type="submit" class="btn primary">${(d.confirmLabel as string) ?? "OK"}</button></div>
      </form>`;
  }

  private confirm(d: Dialog) {
    return html`<h2>${d.title as string}</h2>
      <p>${d.text as string}</p>
      <div class="foot"><button class="btn" @click=${() => this.dismiss()}>Cancel</button>
      <button class="btn ${(d.danger as boolean) ? "danger" : "primary"}" @click=${() => { store.set({ dialog: null }); (d.onConfirm as () => void)(); }}>${(d.confirmLabel as string) ?? "OK"}</button></div>`;
  }
}

@customElement("corestone-new-dialog")
export class NewDialog extends LitElement {
  dialog!: Dialog;
  @state() private types: Schema[] = [];
  @state() private loading = true;
  @state() private schema: Schema | null = null;
  @state() private customType = "";
  @state() private path = "";
  @state() private titleText = "";
  @state() private hid = "";
  @state() private base = "";
  @state() private baseLabel = "";
  @state() private text = "";
  @state() private target = "";
  @state() private targetLabel = "";
  @state() private values: Record<string, unknown> = {};
  @state() private busy = false;
  @state() private error = "";
  /** Set when the chosen type is not visible at the typed folder: the save would be refused. */
  @state() private scopeError = "";
  private listed = false; // the chosen schema came from the visible types, not typed by hand
  private scopeTimer = 0;
  private scopeSeq = 0;

  override createRenderRoot() { return this; }

  override connectedCallback() {
    super.connectedCallback();
    this.path = (this.dialog.folder as string) ?? store.state.route.folder;
    const preset = this.dialog.type as string | undefined;
    api.types(this.path).then((r) => {
      this.types = r.types.filter((t) => !this.dialog.kinds || (this.dialog.kinds as Kind[]).includes(t.kind));
      this.loading = false;
      if (preset) {
        const found = this.types.find((t) => t.type === preset);
        this.choose(found ?? { type: preset, kind: (this.dialog.kinds as Kind[])?.[0] ?? "entry" }, !!found);
      }
    }).catch((e) => { this.error = String(e.message); this.loading = false; });
    if (this.dialog.subject) {
      this.target = String(this.dialog.subject);
      this.targetLabel = String(this.dialog.subjectLabel ?? this.target.slice(0, 8));
    }
  }

  override disconnectedCallback() { window.clearTimeout(this.scopeTimer); super.disconnectedCallback(); }

  private choose(s: Schema, listed = true) {
    this.schema = s;
    this.listed = listed;
    this.values = {};
    for (const f of s.fields ?? []) if (f.default != null) this.values[f.id] = f.default;
    this.error = "";
    this.scopeError = "";
    this.updateComplete.then(() => (this.querySelector<HTMLInputElement>("#new-title, #new-text"))?.focus());
  }

  // Schemas apply lexically along the path, so a folder typed into another
  // scope may see a different schema for the chosen type, or none at all.
  // Follow the typed folder: refresh the visible types, rebuild the form from
  // the schema effective there, and say so before the server refuses the save.
  private onFolder(path: string) {
    this.path = path;
    window.clearTimeout(this.scopeTimer);
    this.scopeTimer = window.setTimeout(() => this.followScope(), 250);
  }

  private async followScope() {
    const seq = ++this.scopeSeq;
    const path = this.path;
    let types: Schema[];
    try {
      types = (await api.types(path)).types.filter((t) => !this.dialog.kinds || (this.dialog.kinds as Kind[]).includes(t.kind));
    } catch {
      return; // the server validates on save either way
    }
    if (seq !== this.scopeSeq || path !== this.path) return;
    this.types = types;
    const chosen = this.schema;
    if (!chosen || !this.listed) return; // a hand-typed type id is not checked against the scope
    const here = types.find((t) => t.type === chosen.type);
    if (!here) {
      this.scopeError = `Type ${displayName(chosen, chosen.type)} is not defined at ${path || "the repository root"}; choose another folder or type.`;
      return;
    }
    this.scopeError = "";
    if (JSON.stringify(here) === JSON.stringify(chosen)) return;
    // a different schema for the same type: keep the values of fields that still exist
    const keep: Record<string, unknown> = {};
    for (const f of here.fields ?? []) {
      if (f.id in this.values) keep[f.id] = this.values[f.id];
      else if (f.default != null) keep[f.id] = f.default;
    }
    this.schema = here;
    this.values = keep;
  }

  private kindOf(): Kind { return this.schema?.kind ?? "entry"; }

  private async create() {
    if (!this.schema || this.busy || this.scopeError) return; // a second click before re-render must be a no-op
    this.busy = true;
    this.error = "";
    const kind = this.kindOf();
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.values)) if (v !== null && v !== undefined && v !== "") fields[k] = v;
    try {
      let view;
      if (kind === "link") {
        if (!this.base || !this.target) throw new Error("Choose a source and a target artifact");
        view = await api.create("links", { type: this.schema.type, source: this.base, target: this.target, fields });
        store.toast(`Link ${this.schema.type} created`, "success");
        store.set({ dialog: null });
        store.refresh();
        return;
      }
      if (kind === "comment") {
        if (!this.target) throw new Error("Choose the artifact to comment on");
        view = await api.create("comments", { type: this.schema.type, subject: this.target, text: this.text, author: store.state.user, fields });
        store.toast("Comment added", "success");
        store.set({ dialog: null });
        store.refresh();
        return;
      }
      const body: Record<string, unknown> = { path: this.path, type: this.schema.type, title: this.titleText, fields };
      if (this.hid.trim()) body.hid = this.hid.trim();
      if (this.base) body.base = this.base;
      if (kind === "document") body.content = [{ id: "b0", type: "paragraph", text: "" }];
      view = await api.create(collectionOf[kind], body);
      store.toast(`${kindLabel[kind]} ${view.meta.hid || ""} created`, "success");
      store.set({ dialog: null });
      store.refresh();
      navigate({ guid: view.meta.guid, folder: view.meta.folder, tab: "" });
    } catch (e) {
      this.error = e instanceof ApiError ? e.message : String((e as Error).message ?? e);
    } finally {
      this.busy = false;
    }
  }

  override render() {
    if (!this.schema) return this.pickType();
    const s = this.schema;
    const kind = this.kindOf();
    return html`<h2><span>New ${displayName(s, s.type)} <span class="muted small">(${kindLabel[kind]})</span></span>
        <button class="btn sm" @click=${() => (this.schema = null)}>← type</button></h2>
      ${this.error ? html`<div class="notice error" role="alert">${this.error}</div>` : nothing}
      <form @submit=${(e: Event) => { e.preventDefault(); this.create(); }}>
        ${kind === "entry" || kind === "document" ? html`
          <div class="field"><label for="new-title">Title<span class="req">*</span></label><div class="value">
            <input id="new-title" type="text" required .value=${this.titleText} @input=${(e: Event) => (this.titleText = (e.target as HTMLInputElement).value)} /></div></div>
          <div class="field"><label for="new-path">Folder</label><div class="value">
            <corestone-folder-field inputId="new-path" test="new-path" .value=${this.path} @folder-change=${(e: CustomEvent<string>) => this.onFolder(e.detail)}></corestone-folder-field>
            ${this.scopeError ? html`<div class="notice error" data-test="scope-notice" role="alert">${this.scopeError}</div>` : nothing}
            <div class="help">Folders organize; identity stays with the GUID. Schemas apply lexically along this path.</div></div></div>
          <div class="field"><label for="new-hid">HID</label><div class="value">
            <input id="new-hid" type="text" .value=${this.hid} placeholder=${s.hid ? `auto: ${s.hid.prefix}${s.hid.separator ?? "-"}n` : "optional, e.g. REQ-42"} @input=${(e: Event) => (this.hid = (e.target as HTMLInputElement).value)} /></div></div>
          ${kind === "entry" ? html`<div class="field"><label>Base (overlay)</label><div class="value">
            ${this.base ? html`<span class="ref-chip">${this.baseLabel}<button type="button" title="Clear base artifact" aria-label="Clear base artifact" @click=${() => { this.base = ""; this.baseLabel = ""; }}>✕</button></span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("base", [s.type], ["entry"])}>${this.base ? "Change…" : "＋ Inherit from an entry…"}</button>
            <div class="help">An overlay keeps only the fields you set here; everything else resolves from its base.</div></div></div>` : nothing}` : nothing}
        ${kind === "link" ? html`
          <div class="field"><label>Source<span class="req">*</span></label><div class="value">
            ${this.base ? html`<span class="ref-chip">${this.baseLabel}</span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("base", s.sourceTypes)}>${this.base ? "Change…" : "Select…"}</button>
            ${s.sourceTypes?.length ? html`<div class="help">allowed: ${s.sourceTypes.join(", ")}</div>` : nothing}</div></div>
          <div class="field"><label>Target<span class="req">*</span></label><div class="value">
            ${this.target ? html`<span class="ref-chip">${this.targetLabel}</span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("target", s.targetTypes)}>${this.target ? "Change…" : "Select…"}</button>
            ${s.targetTypes?.length ? html`<div class="help">allowed: ${s.targetTypes.join(", ")}</div>` : nothing}
            ${s.cardinality ? html`<div class="help">cardinality: ${s.cardinality}</div>` : nothing}</div></div>` : nothing}
        ${kind === "comment" ? html`
          <div class="field"><label>On<span class="req">*</span></label><div class="value">
            ${this.target ? html`<span class="ref-chip">${this.targetLabel}</span>` : nothing}
            <button type="button" class="btn sm" @click=${() => this.pickArtifact("target")}>${this.target ? "Change…" : "Select…"}</button></div></div>
          <div class="field"><label for="new-text">Text<span class="req">*</span></label><div class="value">
            <textarea id="new-text" required .value=${this.text} @input=${(e: Event) => (this.text = (e.target as HTMLTextAreaElement).value)}></textarea></div></div>` : nothing}
        ${(s.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field .field=${f} .value=${this.values[f.id]}
          @field-change=${(e: CustomEvent) => { this.values = { ...this.values, [e.detail.id]: e.detail.value }; }}></corestone-field>`)}
        ${s.workflows?.length ? html`<div class="help" style="margin-top:8px">Workflows ${s.workflows.join(", ")} start in their initial state.</div>` : nothing}
        <div class="foot">
          <button type="button" class="btn" @click=${() => store.set({ dialog: null })}>Cancel</button>
          <button type="submit" class="btn primary" ?disabled=${this.busy || !!this.scopeError} data-test="create">${this.busy ? "Creating…" : "Create"}</button>
        </div>
      </form>`;
  }

  private pickArtifact(which: "base" | "target", types?: string[], kinds?: Kind[]) {
    store.set({ picker: { kind: "pick", title: which === "base" ? "Select artifact" : "Select target", types, kinds, onPick: (s: Summary) => {
      if (which === "base") { this.base = s.guid; this.baseLabel = label(s); } else { this.target = s.guid; this.targetLabel = label(s); }
    } } });
  }

  private pickType() {
    const groups: Record<string, Schema[]> = {};
    for (const t of this.types) (groups[t.kind] ??= []).push(t);
    const order: Kind[] = ["entry", "document", "link", "comment"];
    return html`<h2>What do you want to create?</h2>
      ${this.error ? html`<div class="notice error">${this.error}</div>` : nothing}
      ${this.loading ? html`<p class="muted">Loading types visible at <code>${this.path || "/"}</code>…</p>` : nothing}
      ${!this.loading && !this.types.length ? html`<div class="notice">No schemas are visible at <code>${this.path || "/"}</code>. Define a schema first (or enter a type below).</div>` : nothing}
      ${order.filter((k) => groups[k]?.length).map((k) => html`<div class="nav-title" style="margin-top:10px">${kindPlural[k]}</div>
        <div class="type-grid">${groups[k].map((t) => html`<button class="type-card" data-type=${t.type} @click=${() => this.choose(t)}>
          <div class="kind">${kindIcon(t.kind)}${t.type}</div><div class="name">${displayName(t, t.type)}</div>
          ${t.description ? html`<div class="desc">${t.description}</div>` : nothing}
          ${t.hid ? html`<div class="desc">HID prefix ${t.hid.prefix}</div>` : nothing}</button>`)}</div>`)}
      <div class="inline-form" style="margin-top:16px;align-items:center">
        <input type="text" placeholder="…or type an unlisted type id" .value=${this.customType} @input=${(e: Event) => (this.customType = (e.target as HTMLInputElement).value)} />
        <select id="custom-kind"><option value="entry">entry</option><option value="document">document</option></select>
        <button class="btn" ?disabled=${!this.customType.trim()} @click=${() => this.choose({ type: this.customType.trim(), kind: (this.querySelector("#custom-kind") as HTMLSelectElement).value as Kind })}>Use</button>
      </div>
      <div class="foot"><button class="btn" @click=${() => store.set({ dialog: null })}>Cancel</button></div>`;
  }
}

@customElement("corestone-picker")
export class Picker extends LitElement {
  dialog!: Dialog;
  @state() private q = "";
  @state() private results: Summary[] = [];
  @state() private busy = false;
  private timer = 0;
  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); this.search(); this.updateComplete.then(() => this.querySelector<HTMLInputElement>("input")?.focus()); }

  private search() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(async () => {
      this.busy = true;
      const kinds = (this.dialog.kinds as Kind[] | undefined) ?? ["entry", "document"];
      const types = this.dialog.types as string[] | undefined;
      try {
        if (types && types.length && !types.includes("*")) {
          const all = await Promise.all(types.map((t) => api.search({ q: this.q, type: t, kind: kinds.join(","), limit: 50 })));
          this.results = all.flatMap((r) => r.artifacts);
        } else {
          this.results = (await api.search({ q: this.q, kind: kinds.join(","), limit: 50 })).artifacts;
        }
      } catch (e) {
        store.toast(String((e as Error).message), "error");
      } finally {
        this.busy = false;
      }
    }, 150);
  }

  override render() {
    const exclude = this.dialog.exclude as string | undefined;
    return html`<h2>${this.dialog.title as string}</h2>
      <input type="search" placeholder="Search by title, HID or text…" .value=${this.q} @input=${(e: Event) => { this.q = (e.target as HTMLInputElement).value; this.search(); }} />
      <div class="picker-results">
        ${this.busy && !this.results.length ? html`<div class="empty-state">Searching…</div>` : nothing}
        ${!this.busy && !this.results.length ? html`<div class="empty-state">No matching artifacts</div>` : nothing}
        ${this.results.filter((r) => r.guid !== exclude).map((r) => html`<div class="row" data-guid=${r.guid} @click=${() => { store.set({ picker: null }); (this.dialog.onPick as (s: Summary) => void)(r); }}>
          ${kindIcon(r.kind)}${r.hid ? html`<span class="hid">${r.hid}</span>` : nothing}<span class="grow">${r.title}</span><span class="muted small">${r.type} · ${r.folder || "/"}</span></div>`)}
      </div>
      <div class="foot"><button class="btn" @click=${() => { const c = this.dialog.onCancel as (() => void) | undefined; store.set({ picker: null }); c?.(); }}>Cancel</button></div>`;
  }
}
