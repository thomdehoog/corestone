import { html, nothing } from "lit";
import { LightElement, drag, errorText, prefs } from "@corestone/ui";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { api } from "./api";
import { navigate } from "./router";
import { store, type Dialog, type State } from "./store";
import { themeChoice } from "./components/theme-choice";
import type { RichText } from "@corestone/editor";
import type { Kind, PickerAction, Schema, SortLevel, Summary, TableFilter, View } from "./types";
import type { Table, TableColumn } from "./components/table";
import "./components/table";
import { collectionOf, displayName, kindLabel, kindPlural, label } from "./components/util";
import "./components/type-icon";
import "./components/fields";
import "./components/folder-field";


/** Where the size a dialog was last dragged to is kept: the picker, or a dialog by its resizable name. */
const sizeKey = (name: string) => name === "picker" ? "corestone.pickerSize" : `corestone.dialogSize.${name}`;

/** The size the user last dragged a dialog to, if any. */
function savedSize(name: string): { w: number; h: number } | null {
  try {
    const v = prefs.json<{ w: number; h: number } | null>(sizeKey(name), null);
    return v && v.w > 0 && v.h > 0 ? v : null;
  } catch { return null; }
}
const sizeStyle = (name: string) => { const sz = savedSize(name); return sz ? `width:${sz.w}px;height:${sz.h}px` : ""; };

// Modal dialogs: the "+ New" flow (choose a type → empty schema-generated
// form → create), the artifact picker, and confirmations.

@customElement("corestone-dialogs")
export class Dialogs extends LightElement {
  private unsub?: () => void;
  private s!: State;
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

  /** Drags a dialog's corner (the picker, or one opened with resizable). The dialog is centered
   *  horizontally and top-anchored, so its width changes twice as fast to keep the corner under the pointer. */
  private startResize = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    const box = grip.parentElement!;
    const r = box.getBoundingClientRect();
    const x0 = e.clientX, y0 = e.clientY;
    let size = { w: r.width, h: r.height };
    drag(e, {
      move: (m) => {
        size = {
          w: Math.round(Math.min(Math.max(r.width + 2 * (m.clientX - x0), 360), window.innerWidth * 0.96)),
          h: Math.round(Math.min(Math.max(r.height + (m.clientY - y0), 260), window.innerHeight - r.top - 12)),
        };
        box.style.width = size.w + "px";
        box.style.height = size.h + "px";
      },
      end: () => prefs.setJson(sizeKey(grip.dataset.size ?? "picker"), size),
    });
  };

  /** Double-clicking the grip goes back to the default size. */
  private resetSize = (e: Event) => {
    const grip = e.currentTarget as HTMLElement;
    const box = grip.parentElement!;
    box.style.width = box.style.height = "";
    prefs.remove(sizeKey(grip.dataset.size ?? "picker"));
  };

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
      case "account": body = html`<corestone-account-dialog></corestone-account-dialog>`; break;
      default: body = nothing;
    }
    return html`${d ? html`<div class="backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.dismiss(); }}>
        <div class="dialog ${d.kind === "prompt" || d.kind === "account" ? d.kind : ""} ${d.resizable ? "resizable" : ""}" role="dialog" aria-modal="true"
          style=${d.resizable ? sizeStyle(d.resizable as string) : ""}>${body}
          ${d.resizable ? html`<div class="resize-grip" data-test="dialog-resize" data-size=${d.resizable as string} title="Drag to resize, double-click to reset"
            @pointerdown=${this.startResize} @dblclick=${this.resetSize}></div>` : nothing}</div></div>` : nothing}
      ${p ? html`<div class="backdrop picker-layer" @click=${(e: Event) => { if (e.target === e.currentTarget) { const c = p.onCancel as (() => void) | undefined; store.set({ picker: null }); c?.(); } }}>
        <div class="dialog picker" role="dialog" aria-modal="true" style=${sizeStyle("picker")}>
          <corestone-picker .dialog=${p}></corestone-picker>
          <div class="resize-grip" data-test="picker-resize" title="Drag to resize, double-click to reset" @pointerdown=${this.startResize} @dblclick=${this.resetSize}></div></div></div>` : nothing}`;
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
        ${d.theme ? themeChoice(this.s.theme, (t) => store.setTheme(t)) : nothing}
        <div class="foot"><button type="button" class="btn" @click=${() => this.dismiss()}>Cancel</button>
        <button type="submit" class="btn primary">${(d.confirmLabel as string) ?? "OK"}</button></div>
      </form>`;
  }

  private confirm(d: Dialog) {
    return html`<h2>${d.title as string}</h2>
      <p>${d.text as string}</p>
      ${d.body ? html`<div class="dialog-body">${d.body}</div>` : nothing}
      <div class="foot"><button class="btn" data-test="dialog-cancel" @click=${() => this.dismiss()}>Cancel</button>
      ${d.altLabel ? html`<button class="btn" data-test="dialog-alt" @click=${() => { store.set({ dialog: null }); (d.onAlt as () => void)(); }}>${d.altLabel as string}</button>` : nothing}
      ${d.noConfirm ? nothing : html`<button class="btn ${(d.danger as boolean) ? "danger" : "primary"}" data-test="dialog-confirm" @click=${() => { store.set({ dialog: null }); (d.onConfirm as () => void)(); }}>${(d.confirmLabel as string) ?? "OK"}</button>`}</div>`;
  }
}

@customElement("corestone-new-dialog")
export class NewDialog extends LightElement {
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

  override connectedCallback() {
    super.connectedCallback();
    this.path = (this.dialog.folder as string) ?? store.state.route.folder;
    // made from text of a document: title and text given; the caller gets the entry (onCreated)
    if (typeof this.dialog.presetTitle === "string") this.titleText = this.dialog.presetTitle;
    const preset = this.dialog.type as string | undefined;
    api.types(this.path).then((r) => {
      this.types = r.types.filter((t) => !this.dialog.kinds || (this.dialog.kinds as Kind[]).includes(t.kind));
      this.loading = false;
      if (preset) {
        const found = this.types.find((t) => t.type === preset);
        this.choose(found ?? { type: preset, kind: (this.dialog.kinds as Kind[])?.[0] ?? "entry" }, !!found);
      }
    }).catch((e) => { this.error = errorText(e); this.loading = false; });
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
    // the given text goes into the type's first rich-text field
    const fill = this.dialog.fill as RichText | undefined;
    if (fill && fill.length) {
      const f = (s.fields ?? []).find((x) => x.type === "richtext");
      if (f) this.values[f.id] = fill;
      else this.error = `${displayName(s, s.type)} has no rich-text field: only the title is taken from the text, the rest stays in the document.`;
    }
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

  private cancel() {
    const c = this.dialog.onCancel as (() => void) | undefined;
    store.set({ dialog: null });
    c?.();
  }

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
      if (kind === "document") body.content = [];
      view = await api.create(collectionOf[kind], body);
      store.toast(`${kindLabel[kind]} ${view.meta.hid || ""} created`, "success");
      const onCreated = this.dialog.onCreated as ((v: View) => void | Promise<void>) | undefined;
      if (onCreated) {
        store.set({ dialog: null });
        store.refresh();
        await onCreated(view);
        return;
      }
      store.set({ dialog: null });
      store.refresh();
      navigate({ guid: view.meta.guid, folder: view.meta.folder, tab: "" });
    } catch (e) {
      this.error = errorText(e);
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
        ${(s.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field .field=${f} .value=${this.values[f.id]} .typeId=${s.type} .folder=${this.path}
          @field-change=${(e: CustomEvent) => { this.values = { ...this.values, [e.detail.id]: e.detail.value }; }}></corestone-field>`)}
        ${(s.fields ?? []).some((f) => f.type === "workflow") ? html`<div class="help" style="margin-top:8px">${(s.fields ?? []).filter((f) => f.type === "workflow").map((f) => f.name || f.id).join(", ")}: starts in the initial state.</div>` : nothing}
        <div class="foot">
          <button type="button" class="btn" @click=${() => this.cancel()}>Cancel</button>
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
          <div class="kind"><corestone-type-icon .kind=${t.kind} .type=${t.type} .folder=${this.path} .schema=${t}></corestone-type-icon>${t.type}</div><div class="name">${displayName(t, t.type)}</div>
          ${t.description ? html`<div class="desc">${t.description}</div>` : nothing}
          ${t.hid ? html`<div class="desc">HID prefix ${t.hid.prefix}</div>` : nothing}</button>`)}</div>`)}
      <div class="inline-form" style="margin-top:16px;align-items:center">
        <input type="text" placeholder="…or type an unlisted type id" .value=${this.customType} @input=${(e: Event) => (this.customType = (e.target as HTMLInputElement).value)} />
        <select id="custom-kind"><option value="entry">entry</option><option value="document">document</option></select>
        <button class="btn" ?disabled=${!this.customType.trim()} @click=${() => this.choose({ type: this.customType.trim(), kind: (this.querySelector("#custom-kind") as HTMLSelectElement).value as Kind })}>Use</button>
      </div>
      <div class="foot"><button class="btn" @click=${() => this.cancel()}>Cancel</button></div>`;
  }
}

const PICKER_SORT_KEY = "corestone.pickerSort";

function pickerSort(): SortLevel[] {
  try {
    const v = prefs.json<unknown>(PICKER_SORT_KEY, []);
    return Array.isArray(v) ? v.filter((l) => typeof l?.col === "string" && (l.dir === "asc" || l.dir === "desc")).slice(0, 3) : [];
  } catch { return []; }
}

/** Picker columns; the last one names why a row cannot be picked. */
function pickerColumns(taken?: { guids: Set<string>; note: string }, chosen?: () => Set<string>): TableColumn[] {
  return [
    // choosing several: a checkbox per row (a click on the row ticks it)
    ...(chosen ? [{ id: "$check", name: "", width: 34, sortable: false, cls: "pick-check",
      // (the box only shows the state: a click goes through to the row, which ticks it; live: the
      // box always shows the chosen state, whatever the browser did to it)
      render: (r: Summary) => html`<input type="checkbox" tabindex="-1" aria-label="Choose ${r.hid || r.title}" .checked=${live(chosen().has(r.guid))}
        ?disabled=${!!taken?.guids.has(r.guid)} />` } satisfies TableColumn] : []),
    { id: "$hid", name: "ID", width: 110,
      render: (r) => r.hid ? html`<span class="hid">${r.hid}</span>` : html`<span class="muted mono">${r.guid.slice(0, 8)}</span>` },
    { id: "$title", name: "Title", title: (r) => r.title ?? "",
      render: (r) => html`<corestone-type-icon .kind=${r.kind} .type=${r.type} .folder=${r.folder}></corestone-type-icon>${r.title || html`<span class="muted">${r.kind}</span>`}` },
    { id: "$type", name: "Type", width: 110, cls: "muted small", render: (r, ctx) => ctx.typeName(r) },
    { id: "$folder", name: "Folder", width: 150, cls: "muted small", title: (r) => r.folder || "/",
      render: (r) => taken?.guids.has(r.guid) ? taken.note : r.folder || "/" },
  ];
}

@customElement("corestone-picker")
export class Picker extends LightElement {
  dialog!: Dialog;
  @state() private q = "";
  @state() private filter: TableFilter = {};
  @state() private total = -1;
  /** Choosing several (dialog.multi): the chosen rows, in the order chosen. */
  @state() private chosen = new Set<string>();
  private sort = pickerSort();
  private columns: TableColumn[] = [];
  private timer = 0;
  override connectedCallback() {
    super.connectedCallback();
    this.columns = pickerColumns(this.dialog.taken as { guids: Set<string>; note: string } | undefined, this.multi ? () => this.chosen : undefined);
    this.applyFilter();
    this.updateComplete.then(() => this.querySelector<HTMLInputElement>("input")?.focus());
  }
  override disconnectedCallback() { window.clearTimeout(this.timer); super.disconnectedCallback(); }

  /** "<kind>/*" in types allows every type of a kind; other entries are type ids. */
  private applyFilter() {
    const kinds = (this.dialog.kinds as Kind[] | undefined) ?? ["entry", "document"];
    const types = this.dialog.types as string[] | undefined;
    // dialog.query narrows what is offered, in the query language
    this.filter = { q: this.q.trim(), kind: kinds, ...(types?.length ? { types } : {}), query: (this.dialog.query as string | undefined) || undefined };
  }

  private onInput(e: Event) {
    this.q = (e.target as HTMLInputElement).value;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.applyFilter(), 150);
  }

  private onKey(e: KeyboardEvent) {
    const table = this.querySelector<Table>("corestone-table");
    if (!table) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); table.move(e.key === "ArrowDown" ? 1 : -1); }
    else if (e.key === "PageDown" || e.key === "PageUp") { e.preventDefault(); table.move(e.key === "PageDown" ? 10 : -10); }
    else if (e.key === "Enter") {
      e.preventDefault();
      // choosing several: Enter takes the chosen ones (or the active row when none is chosen yet)
      if (this.multi && this.chosen.size) this.done([...this.chosen]);
      else table.pickActive();
    }
  }

  /** dialog.multi: { verb } — rows are chosen with checkboxes (a click on a row ticks it), then
   *  "<verb> n" or "<verb> all" (every match of the search); onPickMany gets their GUIDs. */
  private get multi(): { verb: string } | undefined { return this.dialog.multi as { verb: string } | undefined; }

  private done(guids: string[]) {
    if (!guids.length) return;
    store.set({ picker: null });
    (this.dialog.onPickMany as (guids: string[]) => void)(guids);
  }

  private toggle(s: Summary) {
    const next = new Set(this.chosen);
    if (!next.delete(s.guid)) next.add(s.guid);
    this.chosen = next;
  }

  /** All matching rows that can be chosen, in the table's order. */
  private allMatches(): string[] {
    const taken = this.dialog.taken as { guids: Set<string> } | undefined;
    return (this.querySelector<Table>("corestone-table")?.matchingKeys ?? []).filter((g) => !taken?.guids.has(g));
  }

  private cancel() { const c = this.dialog.onCancel as (() => void) | undefined; store.set({ picker: null }); c?.(); }

  override render() {
    const exclude = this.dialog.exclude as string | undefined;
    // Shown but not selectable, with a reason (e.g. an entry already in the document).
    const taken = this.dialog.taken as { guids: Set<string>; note: string } | undefined;
    // Optional actions besides picking, e.g. creating or removing a base.
    const actions = (this.dialog.actions as PickerAction[] | undefined) ?? [];
    return html`<h2>${this.dialog.title as string}</h2>
      <input type="search" placeholder="Search by title, HID or text…" aria-label="Search" .value=${this.q} @input=${this.onInput} @keydown=${this.onKey} />
      <corestone-table class="picker-results" navigable allFields .columns=${this.columns} .filter=${this.filter} .sort=${this.sort} .exclude=${exclude ? [exclude] : []}
        .disabled=${taken ? (r: Summary) => taken.guids.has(r.guid) ? taken.note : undefined : undefined} empty="No matching artifacts"
        .selected=${this.multi ? (r: Summary) => this.chosen.has(r.guid) : undefined}
        @sort-change=${(e: CustomEvent<SortLevel[]>) => { this.sort = e.detail; prefs.setJson(PICKER_SORT_KEY, e.detail); }}
        @table-load=${(e: CustomEvent<{ total: number }>) => (this.total = e.detail.total)}
        @row-click=${(e: CustomEvent<Summary>) => {
          if (this.multi) { this.toggle(e.detail); return; }
          store.set({ picker: null }); (this.dialog.onPick as (s: Summary) => void)(e.detail); }}></corestone-table>
      <div class="picker-count muted small" data-test="picker-count">${this.total < 0 ? "" : `${this.total} ${this.total === 1 ? "match" : "matches"}`}</div>
      <div class="foot">${actions.map((a) => html`<button class="btn picker-action ${a.tone}" data-test=${a.test}
          @click=${() => { store.set({ picker: null }); a.run(); }}><span class="act-icon" aria-hidden="true">${a.tone === "add" ? "＋" : "✕"}</span>${a.label}</button>`)}
        <span class="grow"></span>
        ${this.multi ? this.multiButtons(this.multi.verb) : nothing}
        <button class="btn" @click=${() => this.cancel()}>Cancel</button></div>`;
  }

  private multiButtons(verb: string) {
    const taken = (this.dialog.taken as { guids: Set<string> } | undefined)?.guids;
    // (the count of all matches less those that cannot be chosen; the table knows which)
    const all = this.total < 0 ? 0 : this.total;
    const n = this.chosen.size;
    return html`<button class="btn" data-test="pick-all" ?disabled=${!all}
        title=${`Every match of the search, in the order shown${taken?.size ? " (without those that cannot be chosen)" : ""}`}
        @click=${() => this.done(this.allMatches())}>${verb} all</button>
      <button class="btn primary" data-test="pick-chosen" ?disabled=${!n} @click=${() => this.done([...this.chosen])}>${verb}${n ? ` ${n}` : ""}</button>`;
  }
}
