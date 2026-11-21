import { html, nothing, render, type TemplateResult } from "lit";
import { deepEqual, errorText, fmtTime, LightElement, relTime, Resizer, splitter } from "@corestone/ui";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import "@corestone/editor";
import { fileNames, renameFiles, type Block, type DocNode, type DocumentElement, type DocumentHost, type EntryFiles, type ItemLinks, type OutlineItem, type Placed, type RichText } from "@corestone/editor";
import { api, ApiError, server, type SaveChanges } from "./api";
import { clearLeaveGuard, navigate, setLeaveGuard, type LeaveGuard } from "./router";
import { pickArtifact, store, type State, toastError } from "./store";
import type { CommentView, Field, LogEntry, Relationships, Schema, View } from "./types";
import { announceEdit } from "./ws";
import { commentTypeOf, hidLabel, label, showValue, undeclaredField, workflowStates } from "./components/util";
import { MAX_ATTACHMENT, freeFileName } from "./files";
import "./components/type-icon";
import { appIcon, type AppIcon } from "./components/icons";
import "./components/fields";

// Document view (design guide §7.6, §9.5; docs/design/Corestone documents.md): one editor for
// the whole document (a tree of sections with text, pictures, tables and placed entries), the
// title above it, and optional sidebars for the outline, properties, the current entry,
// relationships, comments and versions.

const SIDEBARS = [["outline", "Outline"], ["props", "Properties"], ["entry", "Entry"], ["rel", "Relationships"], ["comments", "Comments"], ["versions", "Versions"]] as const satisfies readonly (readonly [AppIcon, string])[];

/** A placed entry as the document shows it: loaded when it comes near the visible part. */
interface Loaded { view: View | null; schema: Schema | null; missing?: { hid?: string; title?: string } }
/** A new entry made in the document, held until the document is saved (the save creates it). */
interface Held { schema: Schema; folder: string; title: string; fields: Record<string, unknown>; files: string[] }
/** Whether a placed entry is new (a key "new:…" instead of a GUID). */
const isNew = (g: string) => g.startsWith("new:");

/** Document content with the keys of new entries changed by f (in placements and references). */
function mapKeys<T>(v: T, f: (key: string) => string): T {
  if (Array.isArray(v)) return v.map((x) => mapKeys(x, f)) as T;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === "entry" || k === "ref") && typeof x === "string" && isNew(x)) {
      const [key, sec] = x.split("#");
      out[k] = f(key) + (sec ? "#" + sec : "");
    } else out[k] = mapKeys(x, f);
  }
  return out as T;
}

@customElement("corestone-document")
export class DocumentView extends LightElement {
  @property() guid = "";
  private unsub?: () => void;
  private s!: State;
  /** The left edge of the sidebars: their width, px. */
  private readonly side = new Resizer({
    key: "corestone.docSideWidth", fallback: 320, min: 240, max: 720, axis: "x", step: 16, reverse: true,
    at: (m, box) => box.right - m.clientX,
    changed: () => this.requestUpdate(),
  });
  @state() private view: View | null = null;
  @state() private schema: Schema | null = null;
  @state() private docTitle = "";
  @state() private content: DocNode[] = [];
  @state() private fields: Record<string, unknown> = {};
  @state() private outline: OutlineItem[] = [];
  @state() private current: string | null = null; // the placed entry last clicked
  @state() private busy = false;
  @state() private error = "";
  @state() private rel: Relationships | null = null;
  @state() private comments: CommentView[] = [];
  @state() private commentType: string | null = null;
  @state() private history: LogEntry[] = [];
  @state() private commentText = "";
  @state() private pendingFiles: File[] = [];
  @state() private removedFiles: string[] = [];
  private lastTick = -1;
  private editing = false;
  private loadSeq = 0;
  /** Entries placed in the document, shown lazily and kept while the view lives. */
  private entries = new Map<string, Loaded | "loading">();
  /** New entries by key; and the GUIDs saves gave them (the undo history may bring a key back). */
  private held = new Map<string, Held>();
  private savedKeys = new Map<string, string>();
  /** The entry types converting text makes: the document type's entryTypes that are allowed in
   *  its folder (in that order), or every entry type allowed there. */
  private convertTypes: Schema[] = [];
  /** What the server said is wrong with each new entry (its check), by key. */
  private problems = new Map<string, string[]>();
  private checkTimer = 0;
  /** The missing fields in the entry sidebar flash (to draw attention to them). */
  @state() private flash = false;
  private schemas = new Map<string, Promise<Schema | null>>();
  private observer?: IntersectionObserver;
  private blobUrls = new WeakMap<File, string>();
  @state() private dragId: string | null = null;
  @state() private dropAt: number | "end" | null = null;

  /** Asked by the router before leaving this document with unsaved changes. */
  private leaveGuard: LeaveGuard = {
    dirty: () => this.dirty,
    save: async () => { await this.save(); return !this.dirty; },
    discard: () => this.discard(),
    label: () => (this.view ? hidLabel(this.view.meta) : "This document"),
  };

  private get editor(): DocumentElement | null { return this.querySelector("cs-document"); }

  /** Drops unsaved edits: title, content, fields and files go back to the stored version. */
  private discard() {
    if (!this.view) return;
    const d = this.view.data as Record<string, unknown>;
    this.docTitle = String(d.title ?? "");
    this.content = structuredClone((d.content as DocNode[]) ?? []);
    this.fields = structuredClone((d.fields as Record<string, unknown>) ?? {});
    this.pendingFiles = [];
    this.removedFiles = [];
    if (this.editor) this.editor.value = this.content;
    if (this.editing) { announceEdit(this.guid, false); this.editing = false; }
  }

  override connectedCallback() {
    super.connectedCallback();
    setLeaveGuard(this.leaveGuard);
    this.observer = new IntersectionObserver((list) => {
      for (const e of list) {
        if (!e.isIntersecting) continue;
        this.observer!.unobserve(e.target);
        const g = (e.target as HTMLElement).dataset.placement;
        if (g && !this.held.has(g)) void this.loadEntry(this.real(g));
      }
    }, { rootMargin: "600px 0px" });
    this.unsub = store.subscribe((s) => {
      this.s = s;
      if (s.refreshTick !== this.lastTick) {
        this.lastTick = s.refreshTick;
        if (this.view) { this.loadSide(); this.reloadEntries(); }
      }
      this.requestUpdate();
    });
  }
  override disconnectedCallback() {
    this.resizes?.disconnect();
    this.watched = undefined;
    this.unsub?.();
    this.observer?.disconnect();
    clearLeaveGuard(this.leaveGuard);
    if (this.editing) announceEdit(this.guid, false);
    super.disconnectedCallback();
  }
  override willUpdate(changed: Map<string, unknown>) { if (changed.has("guid") && this.guid) this.load(); }

  /** The editor's toolbar lives in the heading bar, next to the sidebar switches. */
  override updated() {
    const slot = this.querySelector(".doc-tools");
    const bar = this.editor?.toolbar();
    if (slot && bar && bar.parentElement !== slot) slot.replaceChildren(bar);
    const scroll = this.querySelector(".doc-scroll");
    if (scroll && scroll !== this.watched) {
      this.resizes ??= new ResizeObserver(() => this.alignTools());
      this.resizes.disconnect();
      this.resizes.observe(scroll);
      this.resizes.observe(this);
      this.watched = scroll;
    }
    this.alignTools();
  }
  private resizes?: ResizeObserver;
  private watched?: Element;

  /** The toolbar starts where the paper starts, when the bar has room for that; otherwise it
   *  follows the left part after a separator. */
  private alignTools() {
    const tools = this.querySelector<HTMLElement>(".doc-tools");
    const page = this.querySelector(".doc-page");
    const right = this.querySelector(".doc-switches");
    const head = this.querySelector(".doc-head");
    if (!tools || !page || !right || !head) return;
    tools.style.marginLeft = "0px";
    const natural = tools.getBoundingClientRect().left;
    // room up to the right part (the right part keeps its place at the bar's end)
    const room = right.getBoundingClientRect().left - 12 - (natural + tools.getBoundingClientRect().width);
    const shift = Math.min(page.getBoundingClientRect().left - natural, room);
    const aligned = shift > 0 && right.getBoundingClientRect().top < tools.getBoundingClientRect().bottom;
    tools.style.marginLeft = aligned ? `${Math.round(shift)}px` : "0px";
    head.classList.toggle("aligned", aligned);
  }

  private get dirty(): boolean {
    if (!this.view) return false;
    const d = this.view.data as Record<string, unknown>;
    return this.docTitle.trim() !== (d.title ?? "") || !deepEqual(this.content, d.content ?? []) || !deepEqual(this.fields, d.fields ?? {})
      || this.pendingFiles.length > 0 || this.removedFiles.length > 0;
  }

  private async load() {
    const seq = ++this.loadSeq;
    const guid = this.guid;
    this.error = "";
    this.view = null;
    this.entries.clear();
    try {
      const view = await api.get(guid);
      if (seq !== this.loadSeq) return;
      this.view = view;
      const d = view.data as Record<string, unknown>;
      this.docTitle = String(d.title ?? "");
      this.content = structuredClone((d.content as DocNode[]) ?? []);
      this.fields = structuredClone((d.fields as Record<string, unknown>) ?? {});
      this.pendingFiles = [];
      this.removedFiles = [];
      const [schema, types] = await Promise.all([api.schemaOf(this.guid).catch(() => ({ schema: null })), api.types(view.meta.folder).catch(() => ({ types: [] }))]);
      if (seq !== this.loadSeq) return;
      this.schema = schema.schema;
      this.commentType = commentTypeOf(types.types);
      const entryTypes = types.types.filter((t) => t.kind === "entry");
      const wanted = this.schema?.entryTypes;
      this.convertTypes = wanted ? wanted.map((id) => entryTypes.find((t) => t.type === id)).filter((t): t is Schema => !!t) : entryTypes;
      this.editor?.refresh(); // the toolbar offers these types
      this.loadSide();
      void this.revealEntry();
    } catch (e) {
      this.error = errorText(e);
    }
  }

  /** A deep link to an entry (?tab=entry:<guid>, from "Documents" on the entry) scrolls to it once. */
  private async revealEntry() {
    const tab = store.state.route.tab;
    if (!tab.startsWith("entry:")) return;
    const guid = tab.slice("entry:".length);
    navigate({ tab: "" }, true);
    await this.updateComplete;
    const el = this.querySelector(`.cs-placement[data-placement="${CSS.escape(guid)}"]`);
    if (!el) return;
    this.current = guid;
    el.scrollIntoView({ block: "center" });
  }

  private async loadSide() {
    const [rel, c, h] = await Promise.all([api.relationships(this.guid).catch(() => null), api.comments(this.guid).catch(() => ({ comments: [] })), api.history(this.guid).catch(() => ({ history: [] }))]);
    this.rel = rel;
    this.comments = c.comments;
    this.history = h.history;
  }

  // ---- entries placed in the document ----

  private schemaOf(v: View): Promise<Schema | null> {
    const key = `${v.meta.type}@${v.meta.folder}`;
    let p = this.schemas.get(key);
    if (!p) { p = api.schemaOf(v.meta.guid).then((r) => r.schema).catch(() => null); this.schemas.set(key, p); }
    return p;
  }

  /** The last known name of a deleted entry (its HID and title), for "missing entry". */
  private lastKnown(guid: string): Promise<{ hid?: string; title?: string } | undefined> {
    return api.deleted(guid).then((r) => r.deleted[0]).catch(() => undefined);
  }

  private async loadEntry(guid: string) {
    if (this.entries.has(guid)) return;
    this.entries.set(guid, "loading");
    let loaded: Loaded;
    try {
      const view = await api.get(guid);
      loaded = { view, schema: await this.schemaOf(view) };
    } catch (e) {
      loaded = { view: null, schema: null, missing: e instanceof ApiError && e.status === 404 ? (await this.lastKnown(guid)) ?? {} : {} };
    }
    this.entries.set(guid, loaded);
    this.editor?.refresh(); // shown again, with its name in cross-references
    if (this.current === guid) this.requestUpdate();
  }

  /** After changes elsewhere: the entries shown are loaded again. */
  private reloadEntries() {
    const shown = [...this.entries.keys()];
    this.entries.clear();
    for (const g of shown) void this.loadEntry(g);
  }

  private readonly host: DocumentHost = {
    guid: undefined,
    pickEntries: (taken) => new Promise((resolve) => {
      store.set({ picker: { kind: "pick", title: "Insert entries", kinds: ["entry"], taken: { guids: new Set(taken), note: "already in this document" },
        multi: { verb: "Insert" }, onPickMany: (guids: string[]) => resolve(guids), onCancel: () => resolve([]) } });
    }),
    renderEntry: (el, p) => this.renderEntry(el, p),
    openEntry: (key, newTab) => {
      const guid = this.real(key);
      if (isNew(guid)) { store.toast("This entry is created when the document is saved.", "info"); return; }
      if (newTab) window.open(`/artifact/${guid}`, "_blank", "noopener");
      else navigate({ guid });
    },
    entryLabel: (key) => {
      const guid = this.real(key);
      const h = this.held.get(guid);
      if (h) return h.title || "New entry";
      const e = this.entries.get(guid);
      if (!e || e === "loading") return undefined;
      return e.view ? (e.view.meta.hid || e.view.meta.title || undefined) : e.missing?.hid;
    },
    entryNumbers: true,
    convertToEntry: (c) => this.newEntry(c),
    entryTypes: () => ({
      remember: this.view?.meta.type ?? "",
      types: this.convertTypes.map((t) => ({ id: t.type, name: t.displayName ?? t.type, icon: () => {
        const el = document.createElement("corestone-type-icon") as HTMLElement & { kind: string; type: string; folder: string; schema: Schema };
        Object.assign(el, { kind: "entry", type: t.type, folder: this.view?.meta.folder ?? "", schema: t });
        return el;
      } })),
    }),
    entryAsText: (key) => this.entryAsText(this.real(key)),
  };

  /** A key's GUID once a save gave it one; otherwise the key (or GUID) itself. */
  private real(key: string): string { return this.savedKeys.get(key) ?? key; }

  /** Makes a new entry of document text, held until the save: of the chosen entry type, its
   *  text in the type's first rich-text field, its fields' defaults set. */
  private async newEntry(c: { type: string; title: string; text: RichText; files: string[] }): Promise<string | null> {
    const folder = this.view?.meta.folder ?? "";
    const schema = this.convertTypes.find((t) => t.type === c.type);
    if (!schema) { store.toast(`Entries of type ${c.type} cannot be made in ${folder || "/"}.`, "error"); return null; }
    const fields: Record<string, unknown> = {};
    for (const f of schema.fields ?? []) if (f.default != null) fields[f.id] = f.default;
    const hasText = Array.isArray(c.text) ? c.text.length > 0 : !!c.text;
    if (hasText) {
      const rich = (schema.fields ?? []).find((f) => f.type === "richtext");
      if (!rich) { store.toast(`${schema.displayName ?? schema.type} has no rich-text field for the text; select a single line for its title.`, "error"); return null; }
      fields[rich.id] = c.text;
    }
    const key = "new:" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    this.held.set(key, { schema, folder, title: c.title, fields, files: c.files });
    void this.check(key).then((ok) => { if (!ok) this.attend(key); });
    return key;
  }

  /** The required fields of a new entry that are still empty. */
  private missing(h: Held): Field[] {
    const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);
    return (h.schema.fields ?? []).filter((f) => f.required && empty(h.fields[f.id]));
  }

  /** Asks the server whether a new entry could be created; true when it could. */
  private async check(key: string): Promise<boolean> {
    const h = this.held.get(key);
    if (!h) return true;
    let problems: string[];
    try {
      problems = (await api.check("entries", { path: h.folder, type: h.schema.type, title: h.title, fields: h.fields })).problems;
    } catch {
      problems = []; // unknown: the save checks again
    }
    if (this.held.get(key) !== h) return true;
    if (problems.length) this.problems.set(key, problems); else this.problems.delete(key);
    this.editor?.refresh(); // the card shows what is missing
    this.requestUpdate();
    return !problems.length && !this.missing(h).length;
  }

  /** Shows a new entry with problems in the entry sidebar (opened if needed), its missing fields flashing. */
  private attend(key: string) {
    this.current = key;
    this.editor?.refresh();
    if (!this.s.route.sidebars.includes("entry")) navigate({ sidebars: [...this.s.route.sidebars, "entry"] }, true);
    this.flash = false;
    requestAnimationFrame(() => { this.flash = true; window.setTimeout(() => (this.flash = false), 1600); });
  }

  /** A field of a new entry changed (in the sidebar): kept, shown, checked again after a pause. */
  private editHeld(key: string, change: (h: Held) => void) {
    const h = this.held.get(key);
    if (!h) return;
    change(h);
    this.touch();
    this.editor?.refresh();
    this.requestUpdate();
    window.clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => void this.check(key), 400);
  }

  /** Copies files (pictures of a text) from one artifact to another; names: their new names. */
  private async copyFiles(names: string[], get: (n: string) => Promise<Blob>, put: (n: string, f: File) => Promise<unknown>): Promise<Map<string, string>> {
    const renamed = new Map<string, string>();
    for (const n of names) {
      try {
        const blob = await get(n);
        const r = await put(n, new File([blob], n, { type: blob.type }));
        if (typeof r === "string" && r !== n) renamed.set(n, r);
      } catch (e) {
        store.toast(`The file ${n} could not be copied: ${errorText(e)}`, "error");
      }
    }
    return renamed;
  }

  /** A placed entry as text of the document: its title (bold), then its rich-text fields (each
   *  under its name when there are several); its pictures become files of the document. */
  private async entryAsText(guid: string): Promise<{ text: RichText } | { error: string }> {
    const h = this.held.get(guid);
    if (h) return { text: this.asText(h.title, h.schema, h.fields) }; // (its pictures are the document's already)
    let v: View, schema: Schema | null;
    try {
      v = await api.get(guid);
      schema = await this.schemaOf(v);
    } catch (e) {
      return { error: `The entry could not be read: ${errorText(e)}` };
    }
    const blocks = this.asText(v.meta.title || v.meta.hid || "", schema, ((v.data as Record<string, unknown>).fields as Record<string, unknown>) ?? {});
    const names = fileNames(blocks);
    const renamed = await this.copyFiles(names, (n) => api.fileBlob(api.fileUrl(guid, n)), (_n, f) => this.docFiles.add(f));
    return { text: renameFiles(blocks, renamed) };
  }

  /** An entry as document text: its title (bold), then its rich-text fields (each under its
   *  name when there are several). */
  private asText(title: string, schema: Schema | null, values: Record<string, unknown>): Block[] {
    const rich = (schema?.fields ?? []).filter((f) => f.type === "richtext" && values[f.id] != null && values[f.id] !== "");
    const blocks: Block[] = [{ text: [{ text: title || "Untitled", bold: true }] }];
    for (const f of rich) {
      if (rich.length > 1) blocks.push({ text: [{ text: f.name ?? f.id, italic: true }] });
      const val = values[f.id] as RichText;
      blocks.push(...(typeof val === "string" ? val.split("\n").map((t): Block => ({ text: t })) : val));
    }
    return blocks;
  }

  /** A placed entry: the built-in card (type, number, HID, title, state and its rich-text fields). */
  private renderEntry(el: HTMLElement, p: Placed) {
    el.classList.add("doc-entry");
    const guid = this.real(p.guid);
    const h = this.held.get(guid);
    if (h) {
      // a new entry: as it will be, marked until the save creates it (its pictures are the document's)
      const rich = (h.schema.fields ?? []).filter((f) => f.type === "richtext" && h.fields[f.id] != null && h.fields[f.id] !== "");
      render(html`<div class="entry-card new ${this.current === p.guid ? "current" : ""}">
        <div class="head">${p.number ? html`<span class="num">${p.number}</span>` : nothing}
          <corestone-type-icon kind="entry" .type=${h.schema.type} .folder=${h.folder}></corestone-type-icon>
          <b class="title">${h.title || html`<span class="muted">Untitled</span>`}</b>
          <span class="pill unsaved" title="This entry is created when the document is saved">not saved yet</span>
          ${this.missing(h).length || this.problems.has(p.guid) ? html`<span class="pill problem" title=${(this.problems.get(p.guid) ?? []).join("\n")}>${this.missing(h).length
            ? `${this.missing(h).map((f) => f.name ?? f.id).join(", ")} missing` : "cannot be created"}</span>` : nothing}</div>
        ${rich.map((f) => html`<div class="rich"><div class="label">${f.name ?? f.id}</div>
          <cs-richtext readonly .value=${h.fields[f.id] as RichText} .files=${this.docFiles}></cs-richtext></div>`)}
      </div>`, el);
      return;
    }
    const e = this.entries.get(guid);
    if (!e || e === "loading") {
      render(html`<div class="entry-card loading"><span class="num">${p.number}</span> Loading entry…</div>`, el);
      if (!e) this.observer?.observe(el);
      return;
    }
    if (!e.view) {
      const name = e.missing?.hid || e.missing?.title || p.guid;
      render(html`<div class="entry-card missing" title="This entry is not in the repository any more">
        <span class="num">${p.number}</span> Missing entry <b>${name}</b></div>`, el);
      return;
    }
    const v = e.view;
    const d = v.data as Record<string, unknown>;
    const values = (d.fields as Record<string, unknown>) ?? {};
    const rich = (e.schema?.fields ?? []).filter((f) => f.type === "richtext" && values[f.id] != null && values[f.id] !== "");
    const files: EntryFiles = { add: () => Promise.reject(new Error("read-only")), url: (n) => api.fileUrl(v.meta.guid, n), list: async () => [] };
    render(html`<div class="entry-card ${this.current === p.guid ? "current" : ""}">
      <div class="head">${p.number ? html`<span class="num">${p.number}</span>` : nothing}
        <corestone-type-icon kind="entry" .type=${v.meta.type} .folder=${v.meta.folder}></corestone-type-icon>
        ${v.meta.hid ? html`<span class="hid">${v.meta.hid}</span>` : nothing}<b class="title">${v.meta.title}</b>
        ${workflowStates(v.data.fields as Record<string, unknown> | undefined).map(([, st]) => html`<span class="pill state">${st}</span>`)}</div>
      ${rich.map((f) => html`<div class="rich"><div class="label">${f.name ?? f.id}</div>
        <cs-richtext readonly .value=${values[f.id] as RichText} .files=${files}></cs-richtext></div>`)}
    </div>`, el);
  }

  // ---- the document's files (pictures in the text), kept with Save ----

  private readonly docFiles: EntryFiles = {
    add: async (file) => {
      if (file.size > MAX_ATTACHMENT) throw new Error(`it is larger than ${MAX_ATTACHMENT >> 20} MiB`);
      const name = freeFileName(file, new Set(await this.docFiles.list()));
      const f = name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
      this.pendingFiles = [...this.pendingFiles, f];
      this.touch();
      return name;
    },
    url: (name) => {
      const p = this.pendingFiles.find((f) => f.name === name);
      if (p) {
        let u = this.blobUrls.get(p);
        if (!u) { u = URL.createObjectURL(p); this.blobUrls.set(p, u); }
        return u;
      }
      return api.fileUrl(this.guid, name);
    },
    list: async () => [...new Set([
      ...(this.view?.attachments ?? []).map((a) => a.name).filter((n) => !this.removedFiles.includes(n)),
      ...this.pendingFiles.map((f) => f.name)])],
    get: async (name) => {
      const p = this.pendingFiles.find((f) => f.name === name);
      if (p) return p;
      return api.fileBlob(api.fileUrl(this.guid, name));
    },
  };

  /** Links in the text to items: chosen with the item picker, opened like references. */
  private readonly itemLinks: ItemLinks = {
    pick: () => pickArtifact({ title: "Link to an item" }).then((s) => (s ? { ref: s.guid, label: label(s) } : null)),
    label: (g) => api.get(g.split("#")[0]).then((v) => label(v.meta)).catch(() => "Missing item"),
    open: (g, newTab) => {
      const guid = g.split("#")[0];
      if (newTab) window.open(`/artifact/${guid}`, "_blank", "noopener");
      else navigate({ guid });
    },
  };

  private touch() {
    if (!this.editing) { this.editing = true; announceEdit(this.guid, true); }
  }

  private async save() {
    if (!this.view || this.busy) return;
    this.busy = true;
    this.error = "";
    const d = this.view.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    const sent = { title: this.docTitle, content: this.content, fields: this.fields };
    if (this.docTitle.trim() !== (d.title ?? "")) patch.title = this.docTitle.trim();
    // new entries: keys saved before are GUIDs now; those still in the document are created with it
    const used = new Set<string>();
    const content = mapKeys(this.content, (k) => { const g = this.savedKeys.get(k); if (!g) used.add(k); return g ?? k; });
    if (!deepEqual(content, d.content ?? [])) patch.content = content;
    // every new entry must check out first: otherwise it is shown, and nothing is sent
    for (const key of used) {
      if (this.held.has(key) && !(await this.check(key))) {
        this.attend(key);
        this.error = "Not saved: a new entry is not complete; see the entry sidebar.";
        this.busy = false;
        return;
      }
    }
    const addEntries: NonNullable<SaveChanges["addEntries"]> = [];
    const entryFiles: { key: string; file: File }[] = [];
    try {
      for (const key of used) {
        const h = this.held.get(key);
        if (!h) throw new Error(`the new entry ${key} is not known any more; remove it from the document`);
        addEntries.push({ key, path: h.folder, type: h.schema.type, title: h.title, fields: h.fields });
        for (const n of h.files) {
          const blob = await this.docFiles.get!(n);
          entryFiles.push({ key, file: blob instanceof File ? blob : new File([blob], n, { type: blob.type }) });
        }
      }
    } catch (e) {
      this.error = `Not saved: ${errorText(e)}`;
      this.busy = false;
      return;
    }
    if (!deepEqual(this.fields, d.fields ?? {})) {
      const f: Record<string, unknown> = {};
      const old = (d.fields as Record<string, unknown>) ?? {};
      for (const [k, v] of Object.entries(this.fields)) if (!deepEqual(v, old[k])) f[k] = v ?? null;
      for (const k of Object.keys(old)) if (!(k in this.fields)) f[k] = null;
      patch.fields = f;
    }
    try {
      const saved = await api.save(this.guid, { patch, removeFiles: this.removedFiles, ...(addEntries.length ? { addEntries } : {}) },
        this.pendingFiles, this.view.etag, entryFiles);
      this.view = saved;
      // the new entries exist now: their GUIDs go into the document in place of their keys
      const unchanged = this.content === sent.content;
      for (const [key, guid] of Object.entries(saved.created ?? {})) { this.savedKeys.set(key, guid); this.held.delete(key); }
      if (this.savedKeys.size) this.editor?.renameEntries(this.savedKeys);
      this.pendingFiles = [];
      this.removedFiles = [];
      // changes made elsewhere to other parts were merged in: show the stored version, except
      // where the user changed something while it was saved
      const sd = saved.data as Record<string, unknown>;
      if (this.docTitle === sent.title) this.docTitle = String(sd.title ?? "");
      if (this.fields === sent.fields) this.fields = structuredClone((sd.fields as Record<string, unknown>) ?? {});
      if (unchanged && !deepEqual(this.content, sd.content ?? [])) {
        this.content = structuredClone((sd.content as DocNode[]) ?? []);
        if (this.editor) this.editor.value = this.content;
      }
      store.toast("Document saved", "success");
      if (this.editing) { announceEdit(this.guid, false); this.editing = false; }
      store.refresh();
    } catch (e) {
      this.error = e instanceof ApiError && e.status === 412 ? "Someone else modified this document. Reload to see their version." : errorText(e);
    } finally {
      this.busy = false;
    }
  }

  // ---- render ----

  override render() {
    if (!this.view) return html`<div class="empty-state">${this.error || "Loading…"}</div>`;
    const r = this.s.route;
    const v = this.view;
    const others = (this.s.presence[this.guid]?.editors ?? []).filter((n) => n !== this.s.user);
    this.host.guid = this.guid;
    return html`
      <div class="doc-head doc-toolbar" @keydown=${this.saveKey}>
          <div class="doc-left"><button class="icon-btn" data-tip="Back to overview" aria-label="Back to overview" @click=${() => navigate({ guid: null, sidebars: [] })}>${appIcon("close")}</button>
          <span class="doc-kind" title=${`${this.schema?.displayName ?? v.meta.type} in ${v.meta.folder || "/"}`}>${v.meta.hid ? html`<span class="hid">${v.meta.hid}</span>` : html`<span class="muted small">${this.schema?.displayName ?? v.meta.type}</span>`}</span>
          <input class="doc-title-input" aria-label="Title" placeholder="Title" .value=${live(this.docTitle)} size=${Math.max(8, Math.min(48, this.docTitle.length + 1))}
            @input=${(e: Event) => { this.docTitle = (e.target as HTMLInputElement).value; this.touch(); }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); this.editor?.focus(); } }} />
          ${others.length ? html`<span class="presence">✎ ${others.join(", ")} editing</span>` : nothing}</div>
          <span class="sep doc-sep"></span>
          <div class="doc-tools"></div>
          <span class="doc-switches">${SIDEBARS.map(([id, name]) => html`<button class="icon-btn" data-test=${"sb-" + id} aria-pressed=${r.sidebars.includes(id)}
              aria-label=${name} data-tip=${(r.sidebars.includes(id) ? "Hide " : "Show ") + name.toLowerCase()}
              @click=${() => navigate({ sidebars: r.sidebars.includes(id) ? r.sidebars.filter((x) => x !== id) : [...r.sidebars, id] }, true)}>${appIcon(id)}</button>`)}
          <span class="sep"></span>
          <button class="icon-btn save ${this.dirty ? "dirty" : ""}" data-test="save" ?disabled=${!this.dirty || this.busy} @click=${this.save}
            data-tip=${this.busy ? "Saving…" : this.dirty ? "Save (Ctrl+S)" : "Saved: no changes"}>${appIcon("save")}<span class="vh">${this.busy ? "Saving…" : this.dirty ? "Save" : "Saved"}</span></button></span>
      </div>
      <div class="doc-main" @keydown=${this.saveKey}>
        ${this.error ? html`<div class="notice error">${this.error} <button class="icon-btn" data-tip="Reload the stored version" @click=${this.load}>${appIcon("reload")}<span class="vh">Reload</span></button></div>` : nothing}
        <div class="doc-scroll"><div class="doc-page">
          <cs-document .host=${this.host} .items=${this.itemLinks} .files=${this.docFiles} .diagrams=${server.diagrams || undefined} .value=${this.content}
            @change=${(e: CustomEvent<DocNode[]>) => { if (e.target !== e.currentTarget) return; this.content = e.detail; this.touch(); }}
            @outline=${(e: CustomEvent<OutlineItem[]>) => { this.outline = e.detail; }}
            @click=${(e: Event) => { const g = (e.target as HTMLElement).closest<HTMLElement>(".cs-placement")?.dataset.placement; if (g && g !== this.current) { this.current = g; this.editor?.refresh(); } }}></cs-document>
        </div></div>
      </div>
      ${r.sidebars.length ? html`${splitter(this.side, "doc-splitter", "doc-splitter")}
        <aside class="doc-side" style=${`--doc-side-w:${this.side.value}px`}>${r.sidebars.map((id) => this.sidebar(id))}</aside>` : nothing}`;
  }

  /** Ctrl+S saves. */
  private readonly saveKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); void this.save(); } };

  /** A sidebar's heading, with a button that closes it. */
  private sideHead(id: string, title: string): TemplateResult {
    return html`<div class="side-head"><h4>${title}</h4><button class="icon-btn" data-tip="Close" aria-label="Close ${title}" data-test=${"close-" + id}
      @click=${() => navigate({ sidebars: this.s.route.sidebars.filter((x) => x !== id) }, true)}>${appIcon("close", 16)}</button></div>`;
  }

  /** The outline: the sections in order; a click goes there. A section is moved with its grip:
   *  over the upper half of a row it goes before that row, over the lower half before the next
   *  one, below the last row to the end; a line shows where, indented to the level it takes. */
  private outlinePanel(): TemplateResult {
    const items = this.outline;
    if (!items.length) return html`<div class="muted small">No headings yet. Make a paragraph a heading with H in the toolbar.</div>`;
    const parentOf = (i: number): string | null => {
      for (let j = i - 1; j >= 0; j--) if (items[j].depth === items[i].depth - 1) return items[j].id;
      return null;
    };
    const indexOf = (i: number): number => {
      let n = 0;
      for (let j = i - 1; j >= 0 && items[j].depth >= items[i].depth; j--) if (items[j].depth === items[i].depth) n++;
      return n;
    };
    const indent = (depth: number) => (depth - 1) * 14 + 4;
    // the dragged section and the ones inside it: no place to drop it
    const from = items.findIndex((x) => x.id === this.dragId);
    const inside = (i: number) => {
      if (from < 0 || i < from) return false;
      for (let j = from + 1; j <= i; j++) if (items[j].depth <= items[from].depth) return false;
      return true;
    };
    const over = (e: DragEvent, at: number | "end") => {
      if (!this.dragId) return;
      if (at !== "end" && at >= items.length) at = "end";
      if (at !== "end" && inside(at)) { this.dropAt = null; return; }
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.dropAt = at;
    };
    const overRow = (e: DragEvent, i: number) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      over(e, e.clientY > r.top + r.height / 2 ? i + 1 : i);
    };
    const end = () => { this.dragId = null; this.dropAt = null; };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      const id = this.dragId, at = this.dropAt;
      end();
      if (!id || at === null) return;
      if (at === "end") this.editor?.moveSection(id, null, Number.MAX_SAFE_INTEGER);
      else if (!inside(at)) this.editor?.moveSection(id, parentOf(at), indexOf(at));
    };
    const last = items.length - 1;
    return html`<div class="outline ${this.dragId ? "dragging" : ""}" role="tree" aria-label="Outline"
        @dragover=${(e: DragEvent) => over(e, "end")} @drop=${drop} @dragleave=${(e: DragEvent) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as globalThis.Node | null)) this.dropAt = null; }}>
      ${items.map((it, i) => html`<div class="outline-row ${this.dropAt === i ? "drop-before" : ""} ${i === last && this.dropAt === "end" ? "drop-after" : ""}
          ${this.dragId === it.id ? "moving" : ""}" role="treeitem" aria-level=${it.depth} data-section=${it.id}
          style=${`--ind:${indent(it.depth)}px`}
          @dragover=${(e: DragEvent) => overRow(e, i)} @drop=${drop}
          @click=${() => this.editor?.revealSection(it.id)}>
          <span class="num">${it.number}</span><span class="t">${it.title || html`<span class="muted">Untitled</span>`}</span>
          ${it.entries ? html`<span class="count" title="Entries in this section">${it.entries}</span>` : nothing}
          <span class="grip" draggable="true" data-tip="Drag to move the section" aria-label="Move ${it.title || "section"}" @click=${(e: Event) => e.stopPropagation()}
            @dragstart=${(e: DragEvent) => {
              this.dragId = it.id;
              e.dataTransfer?.setData("text/plain", it.title);
              if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setDragImage((e.target as HTMLElement).closest(".outline-row")!, 12, 12); }
            }}
            @dragend=${end}>${appIcon("grip", 14)}</span></div>`)}
    </div>`;
  }

  /** A new entry in the entry sidebar: its title and fields, editable; what is missing marked. */
  private heldPanel(key: string): TemplateResult {
    const h = this.held.get(key)!;
    const missing = new Set(this.missing(h).map((f) => f.id));
    const problems = this.problems.get(key) ?? [];
    return html`${this.sideHead("entry", "New entry")}
      <div class="held-entry ${this.flash ? "flash" : ""}">
        <div class="muted small"><corestone-type-icon kind="entry" .type=${h.schema.type} .folder=${h.folder} .schema=${h.schema}></corestone-type-icon>
          ${h.schema.displayName ?? h.schema.type} in ${h.folder || "/"} · created when the document is saved</div>
        ${missing.size || problems.length ? html`<div class="notice error" role="alert" data-test="held-problems">${missing.size
          ? `Fill in ${[...missing].map((id) => h.schema.fields?.find((f) => f.id === id)?.name ?? id).join(", ")}: the entry cannot be created without.`
          : problems.join(" ")}</div>` : nothing}
        <div class="field"><label for="held-title">Title</label><div class="value">
          <input id="held-title" type="text" .value=${live(h.title)} @input=${(e: Event) => this.editHeld(key, (x) => { x.title = (e.target as HTMLInputElement).value; })} /></div></div>
        ${(h.schema.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field class=${missing.has(f.id) ? "missing" : ""} .field=${f} .value=${h.fields[f.id]}
          .files=${this.docFiles} .typeId=${h.schema.type} .folder=${h.folder}
          @field-change=${(e: CustomEvent) => this.editHeld(key, (x) => { if (e.detail.value == null) delete x.fields[e.detail.id]; else x.fields[e.detail.id] = e.detail.value; })}></corestone-field>`)}
      </div>`;
  }

  private sidebar(id: string): TemplateResult {
    const v = this.view!;
    switch (id) {
      case "outline":
        return html`${this.sideHead(id, "Outline")}${this.outlinePanel()}`;
      case "props":
        return html`${this.sideHead(id, "Document properties")}
          <dl class="kv"><dt>Type</dt><dd>${v.meta.type}</dd><dt>Folder</dt><dd>${v.meta.folder || "/"}</dd><dt>GUID</dt><dd class="mono small">${v.meta.guid}</dd><dt>Modified</dt><dd>${relTime(v.meta.modifiedAt)}</dd>
            ${workflowStates(this.fields).map(([w, st]) => html`<dt>${this.schema?.fields?.find((f) => f.id === w)?.name || w}</dt><dd><span class="pill state">${st}</span></dd>`)}</dl>
          ${(this.schema?.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field .field=${f} .value=${this.fields[f.id]} .attachments=${v.attachments ?? []} .typeId=${v.meta.type} .folder=${v.meta.folder}
            @field-change=${(e: CustomEvent) => { const n = { ...this.fields }; if (e.detail.value == null) delete n[e.detail.id]; else n[e.detail.id] = e.detail.value; this.fields = n; this.touch(); }}></corestone-field>`)}
          ${Object.keys(this.fields).filter((k) => !this.schema?.fields?.some((f) => f.id === k)).map((k) => html`<corestone-field .field=${undeclaredField(k, this.fields[k])} .value=${this.fields[k]} undeclared
            @field-change=${(e: CustomEvent) => { const n = { ...this.fields }; delete n[e.detail.id]; this.fields = n; this.touch(); }}></corestone-field>`)}
          <button class="icon-btn" style="margin-top:8px" data-tip="Open as artifact detail" @click=${() => navigate({ guid: this.guid, tab: "general" }, true)}>${appIcon("open")}<span class="vh">Open as artifact detail</span></button>`;
      case "entry": {
        if (this.current && this.held.has(this.current)) return this.heldPanel(this.current);
        const e = this.current ? this.entries.get(this.real(this.current)) : undefined;
        const meta = e && e !== "loading" ? e.view?.meta : undefined;
        const fields = (e && e !== "loading" ? (e.view?.data as Record<string, unknown> | undefined)?.fields : undefined) as Record<string, unknown> | undefined;
        return html`${this.sideHead(id, "Current entry")}${meta ? html`<div><b>${meta.hid ?? ""}</b> ${meta.title}</div>
          <dl class="kv">${Object.entries(fields ?? {}).map(([k, val]) => html`<dt>${k}</dt><dd class="pre-line">${showValue(val)}</dd>`)}</dl>
          <button class="icon-btn" data-tip="Open the entry" @click=${() => navigate({ guid: meta.guid })}>${appIcon("open")}<span class="vh">Open entry</span></button>` : html`<div class="muted small">Click an entry in the document.</div>`}`;
      }
      case "rel":
        return html`${this.sideHead(id, "Relationships")}${!this.rel || (!this.rel.incoming.length && !this.rel.outgoing.length) ? html`<div class="muted small">No links.</div>` : nothing}
          ${this.rel?.outgoing.map((l) => html`<div>→ <span class="muted small">${l.link.type}</span> <a href="#" @click=${(e: Event) => { e.preventDefault(); navigate({ guid: l.other.guid }); }}>${label(l.other)}</a></div>`)}
          ${this.rel?.incoming.map((l) => html`<div>← <span class="muted small">${l.link.type}</span> <a href="#" @click=${(e: Event) => { e.preventDefault(); navigate({ guid: l.other.guid }); }}>${label(l.other)}</a></div>`)}`;
      case "comments":
        return html`${this.sideHead(id, "Comments")}${this.comments.map((c) => html`<div class="comment"><div class="who"><b>${c.meta.author}</b> · ${fmtTime(c.meta.created)}</div><div class="text">${String(c.data?.text ?? "")}</div></div>`)}
          ${!this.commentType ? html`<div class="muted small">No comment type is defined here, so no comments can be added.</div>` : html`<div class="inline-form"><textarea placeholder="Comment…" .value=${this.commentText} @input=${(e: Event) => (this.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
          <button class="icon-btn" data-tip="Post the comment" @click=${async () => { if (!this.commentText.trim()) return; try { await api.create("comments", { subject: this.guid, type: this.commentType, text: this.commentText, author: this.s.user }); this.commentText = ""; this.loadSide(); } catch (e) { toastError(e); } }}>${appIcon("send")}<span class="vh">Post</span></button></div>`}`;
      case "versions":
        return html`${this.sideHead(id, "Versions")}${this.history.map((h) => html`<div class="small"><span class="muted">${fmtTime(h.time)}</span> ${h.subject} <span class="mono muted">${h.sha.slice(0, 7)}</span></div>`)}`;
    }
    return html``;
  }
}
