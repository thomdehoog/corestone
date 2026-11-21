import { html, nothing, type TemplateResult } from "lit";
import { LightElement, safeHref } from "@corestone/ui";
import { customElement, property, state } from "lit/decorators.js";
import "@corestone/editor";
import "./enum-control";
import { api, server } from "../api";
import { pickArtifact, store } from "../store";
import type { EntryFiles, ItemLinks, RichText } from "@corestone/editor";
import type { Attachment, Field, Summary } from "../types";
import { hasSource, knownOptions, withMissing } from "./options";
import { label, showValue } from "./util";

// Schema-driven field editor (design guide §4.6, §7.10): one element per
// field definition, rendering the right input for the field type and
// emitting "field-change" with the new value (null = unset).

export type FieldValue = unknown;

// Values in use per type and field, for extendable enumerations: their
// extra values live only in the artifacts. Shared briefly by all editors.
const usedValues = new Map<string, { at: number; values: Promise<string[]> }>();
function valuesInUse(type: string, field: string, folder: string): Promise<string[]> {
  const key = JSON.stringify([type, field, folder]);
  const hit = usedValues.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.values;
  const values = api.values(type, field, folder).then((r) => r.values.map((v) => v.value)).catch((error) => { usedValues.delete(key); throw error; });
  usedValues.set(key, { at: Date.now(), values });
  return values;
}

/** How a field relates to the entry's overlay base: shown from the base and locked, or set here over a base value. */
export interface OverlayState { from: string; state: "inherited" | "overridden"; baseValue: unknown }

/** How overlays resolve, shown wherever the overlay chain or a field's origin appears. */
export const OVERLAY_HELP = "An overlay inherits every field from its base. Values set in the overlay take precedence; everything else comes from the base.";

@customElement("corestone-field")
export class FieldEditor extends LightElement {
  @property({ attribute: false }) field!: Field;
  @property({ attribute: false }) value: FieldValue = undefined;
  @property({ attribute: false }) overlay: OverlayState | null = null;
  @property({ attribute: false }) attachments: Attachment[] = [];
  /** The entry's files for images and file links in rich text (only where the entry exists). */
  @property({ attribute: false }) files?: EntryFiles;
  @property({ type: Boolean }) readonly = false;
  /** The artifact type, so extendable enumerations can suggest the values in use. */
  @property({ attribute: false }) typeId = "";
  @property({ attribute: false }) folder = "";
  @state() private suggestionQuery = "";
  /** The field is stored but the type does not define it: shown read-only, may be removed. */
  @property({ type: Boolean }) undeclared = false;
  /** In a historic version: the change shown modified this field. */
  @property({ type: Boolean }) changed = false;
  @state() private used: string[] = [];
  @state() private globalUsed: string[] = [];
  private usedKey = "";
  private refCache = new Map<string, Summary | null>();
  /** Links in rich text to items: chosen with the item picker, opened like references. */
  private readonly itemLinks: ItemLinks = {
    pick: () => pickArtifact({ title: "Link to an item" }).then((s) => (s ? { ref: s.guid, label: label(s) } : null)),
    label: (g) => api.get(g).then((v) => label(v.meta)).catch(() => "Missing item"),
    open: (g, newTab) => {
      if (newTab) window.open(`/artifact/${g}`, "_blank", "noopener");
      else this.dispatchEvent(new CustomEvent("open-artifact", { detail: g, bubbles: true }));
    },
  };

  private emit(v: FieldValue) {
    this.value = v;
    this.dispatchEvent(new CustomEvent("field-change", { detail: { id: this.field.id, value: v }, bubbles: true }));
  }

  private overlayEvent(name: "overlay-unlock" | "overlay-revert") {
    this.dispatchEvent(new CustomEvent(name, { detail: { id: this.field.id }, bubbles: true }));
  }

  private overlayNote() {
    const o = this.overlay;
    if (!o) return nothing;
    if (this.readonly) return html`<div class="inherited ${o.state === "overridden" ? "overridden" : ""}" title=${OVERLAY_HELP}>${o.state === "inherited" ? "inherited from" : "overrides"} base <b>${o.from}</b></div>`;
    return o.state === "inherited"
      ? html`<div class="inherited" title=${OVERLAY_HELP}>inherited from base <b>${o.from}</b> ·
          <button type="button" data-test="override" @click=${() => this.overlayEvent("overlay-unlock")}>🔓 override</button></div>`
      : html`<div class="inherited overridden" title=${OVERLAY_HELP}>overrides base <b>${o.from}</b> ·
          <button type="button" data-test="revert" title=${"Base value: " + showValue(o.baseValue)}
            @click=${() => this.overlayEvent("overlay-revert")}>↩ revert to base</button></div>`;
  }

  /** Inherited values are shown from the base and stay locked until overridden. */
  private get disabled() { return this.readonly || this.undeclared || this.overlay?.state === "inherited"; }

  override willUpdate() {
    const f = this.field;
    const global = this.suggestionQuery.trim().length >= 2;
    const key = f.type === "enum" && f.extendable && this.typeId ? JSON.stringify([this.typeId, f.id, this.folder, global]) : "";
    if (key !== this.usedKey) {
      this.usedKey = key;
      this.used = [];
      this.globalUsed = [];
      if (key) void Promise.all([
        valuesInUse(this.typeId, f.id, this.folder),
        global ? valuesInUse(this.typeId, f.id, "") : Promise.resolve([]),
      ]).then(([local, all]) => {
        if (this.usedKey === key) { this.used = local; this.globalUsed = all; }
      }).catch((error: Error) => {
        if (this.usedKey === key) store.toast("Could not load suggestions: " + error.message, "error");
      });
    }
  }

  override render() {
    const f = this.field;
    return html`<div class="field ${this.disabled ? "locked" : ""} ${this.changed ? "changed" : ""}" data-field=${f.id}>
      <label for=${"f-" + f.id} title=${this.changed ? "Changed in this version" : nothing}>${f.name || f.id}${f.required ? html`<span class="req" title="required">*</span>` : nothing}</label>
      <div class="value">
        ${this.input()}
        ${f.description ? html`<div class="help">${f.description}</div>` : nothing}
        ${this.overlayNote()}
        ${this.undeclared ? html`<div class="inherited undeclared">not defined for this type${this.readonly ? " (today)" : html` ·
          <button type="button" data-test="remove-field" @click=${() => this.emit(null)}>✕ remove</button>`}</div>` : nothing}
      </div>
    </div>`;
  }

  private text(type: string, extra: Record<string, unknown> = {}): TemplateResult {
    const v = this.value == null ? "" : String(this.value);
    return html`<input id=${"f-" + this.field.id} type=${type} .value=${v} ?disabled=${this.disabled}
      placeholder=${(extra.placeholder as string) ?? ""} step=${(extra.step as string) ?? nothing}
      @input=${(e: Event) => this.emit((e.target as HTMLInputElement).value || null)} />`;
  }

  private input(): TemplateResult {
    const f = this.field;
    const id = "f-" + f.id;
    switch (f.type) {
      case "boolean":
        return html`<div class="check"><input id=${id} type="checkbox" .checked=${this.value === true} ?disabled=${this.disabled}
          @change=${(e: Event) => this.emit((e.target as HTMLInputElement).checked)} /><span class="muted small">${this.value === true ? "yes" : "no"}</span></div>`;
      case "integer":
        return html`<input id=${id} type="number" step="1" .value=${this.value == null ? "" : String(this.value)} ?disabled=${this.disabled}
          @input=${(e: Event) => { const t = (e.target as HTMLInputElement).value; this.emit(t === "" ? null : parseInt(t, 10)); }} />`;
      case "float":
      case "currency":
        return html`<div style="display:flex;gap:6px;align-items:center">
          <input id=${id} type="number" step="any" .value=${this.value == null ? "" : String(this.value)} ?disabled=${this.disabled}
            @input=${(e: Event) => { const t = (e.target as HTMLInputElement).value; this.emit(t === "" ? null : parseFloat(t)); }} />
          ${f.type === "currency" ? html`<span class="muted">${f.currency ?? ""}</span>` : nothing}</div>`;
      case "date":
        return this.text("date");
      case "time":
        return this.text("time");
      case "datetime": {
        const v = this.value ? String(this.value).replace(/Z$|[+-]\d\d:\d\d$/, "").slice(0, 16) : "";
        return html`<input id=${id} type="datetime-local" .value=${v} ?disabled=${this.disabled}
          @input=${(e: Event) => { const t = (e.target as HTMLInputElement).value; this.emit(t ? new Date(t).toISOString() : null); }} />`;
      }
      case "multiline":
        return html`<textarea id=${id} .value=${this.value == null ? "" : String(this.value)} ?disabled=${this.disabled} rows="3"
          @input=${(e: Event) => this.emit((e.target as HTMLTextAreaElement).value || null)}></textarea>`;
      case "richtext":
        // plain text (older values, or nothing formatted) or paragraphs; empty is unset
        return html`<cs-richtext id=${id} .value=${(this.value ?? "") as RichText} .items=${this.itemLinks} .files=${this.files} ?readonly=${this.disabled}
          .diagrams=${server.diagrams || undefined}
          @change=${(e: CustomEvent<RichText>) => this.emit(e.detail === "" ? null : e.detail)}></cs-richtext>`;
      case "enum":
        return this.enumInput();
      case "hyperlink":
        return html`<div style="display:flex;gap:6px">${this.text("url", { placeholder: "https://" })}
          ${safeHref(this.value) ? html`<a class="btn sm" href=${safeHref(this.value)!} target="_blank" rel="noopener noreferrer">open</a>`
            : this.value ? html`<span class="error small" title="only http(s), ftp and mailto links are rendered">unsafe link</span>` : nothing}</div>`;
      case "reference":
        return this.refInput(false);
      case "references":
        return this.refInput(true);
      case "attachment":
        return html`<select id=${id} ?disabled=${this.disabled} @change=${(e: Event) => this.emit((e.target as HTMLSelectElement).value || null)}>
          <option value="">— none —</option>
          ${this.attachments.map((a) => html`<option value=${a.name} ?selected=${this.value === a.name}>${a.name}</option>`)}
          ${this.value && !this.attachments.some((a) => a.name === this.value) ? html`<option value=${String(this.value)} selected>${String(this.value)} (missing)</option>` : nothing}
        </select>`;
      case "json":
        return html`<textarea id=${id} class="mono" rows="4" ?disabled=${this.disabled} .value=${this.value == null ? "" : JSON.stringify(this.value, null, 2)}
          @change=${(e: Event) => { const t = (e.target as HTMLTextAreaElement).value.trim(); if (!t) return this.emit(null);
            try { this.emit(JSON.parse(t)); (e.target as HTMLElement).classList.remove("error"); } catch { (e.target as HTMLElement).classList.add("error"); store.toast("Invalid JSON in " + (f.name || f.id), "error"); } }}></textarea>`;
      case "workflow":
        return html`<span class="pill state">${this.value ?? "—"}</span> <span class="muted small">managed through transitions</span>`;
      case "hid":
      case "text":
      default:
        return this.text("text");
    }
  }

  private enumInput(): TemplateResult {
    const f = this.field;
    if (hasSource(f)) {
      // a dynamic enumeration: the options are artifacts; without the type they cannot be loaded
      const options = this.typeId ? knownOptions(this.typeId, f.id, this.folder, () => this.requestUpdate()) : [];
      return html`<corestone-enum .options=${withMissing(options ?? [], options ? this.value : null)} .value=${this.value}
        .folder=${this.folder} .label=${f.name || f.id} .multiple=${!!f.multiple} .readonly=${!!this.disabled || !options}
        @enum-change=${(e: CustomEvent<FieldValue>) => this.emit(e.detail)}></corestone-enum>`;
    }
    const query = this.suggestionQuery.trim().toLowerCase();
    const suggestions = [...new Set([...this.used, ...this.globalUsed.filter((v) => query.length >= 2 && v.toLowerCase().includes(query))])];
    return html`<corestone-enum .options=${f.options ?? []} .suggestions=${suggestions} .value=${this.value}
      .folder=${this.folder} .label=${f.name || f.id} .multiple=${!!f.multiple} .extendable=${!!f.extendable}
      .readonly=${!!this.disabled}
      @enum-query=${(e: CustomEvent<string>) => { this.suggestionQuery = e.detail; }}
      @enum-change=${(e: CustomEvent<FieldValue>) => this.emit(e.detail)}></corestone-enum>`;
  }

  private refInput(multiple: boolean): TemplateResult {
    const cur: string[] = multiple ? (Array.isArray(this.value) ? (this.value as string[]) : []) : this.value ? [String(this.value)] : [];
    for (const g of cur) {
      if (!this.refCache.has(g)) {
        this.refCache.set(g, null);
        api.get(g).then((v) => { this.refCache.set(g, v.meta); this.requestUpdate(); }).catch(() => { this.refCache.set(g, null); });
      }
    }
    const pick = () => void pickArtifact({ title: `Select ${this.field.name || this.field.id}`, types: this.field.targetTypes }).then((s) => {
      if (s) this.emit(multiple ? [...new Set([...cur, s.guid])] : s.guid);
    });
    const remove = (g: string) => (multiple ? this.emit(cur.filter((x) => x !== g).length ? cur.filter((x) => x !== g) : null) : this.emit(null));
    return html`<div>
      ${cur.map((g) => html`<span class="ref-chip"><a href=${"/artifact/" + g} @click=${(e: Event) => { e.preventDefault(); this.dispatchEvent(new CustomEvent("open-artifact", { detail: g, bubbles: true })); }}>${label(this.refCache.get(g)) === "(missing)" ? g.slice(0, 8) + "…" : label(this.refCache.get(g))}</a>
        ${this.disabled ? nothing : html`<button type="button" title="Remove reference" aria-label="Remove reference" @click=${() => remove(g)}>✕</button>`}</span>`)}
      ${this.disabled ? nothing : html`<button type="button" class="btn sm" @click=${pick}>${multiple || !cur.length ? "＋ Select…" : "Change…"}</button>`}
    </div>`;
  }
}

/** Builds the initial values of an empty form from defaults. */
export function defaultValues(fields: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (f.default !== undefined && f.default !== null) out[f.id] = f.default;
  return out;
}
