import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { api, ApiError } from "./api";
import { navigate } from "./router";
import { store, type State } from "./store";
import type { Block, CommentView, LogEntry, Relationships, Schema, Summary, View } from "./types";
import { announceEdit } from "./ws";
import { blockId, deepEqual, fmtTime, kindIcon, label, relTime, safeImageSrc } from "./util";
import "./fields";

// Document view (design guide §7.6, §9.5): a distraction-free editor of
// the hierarchical block content (sections, paragraphs, entry references,
// images, lists, code) with optional sidebars for properties, the current
// entry, relationships, comments and versions.

const SIDEBARS = [["props", "Properties"], ["entry", "Entry"], ["rel", "Relationships"], ["comments", "Comments"], ["versions", "Versions"]] as const;

@customElement("corestone-document")
export class DocumentView extends LitElement {
  @property() guid = "";
  private unsub?: () => void;
  private s!: State;
  @state() private view: View | null = null;
  @state() private schema: Schema | null = null;
  @state() private docTitle = "";
  @state() private blocks: Block[] = [];
  @state() private fields: Record<string, unknown> = {};
  @state() private focused: string | null = null;
  @state() private busy = false;
  @state() private error = "";
  @state() private rel: Relationships | null = null;
  @state() private comments: CommentView[] = [];
  @state() private history: LogEntry[] = [];
  @state() private commentText = "";
  private entries = new Map<string, Summary | null>();
  private lastTick = -1;
  private editing = false;
  private loadSeq = 0;

  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => {
      this.s = s;
      if (s.refreshTick !== this.lastTick) { this.lastTick = s.refreshTick; if (this.view) this.loadSide(); }
      this.requestUpdate();
    });
  }
  override disconnectedCallback() { this.unsub?.(); if (this.editing) announceEdit(this.guid, false); super.disconnectedCallback(); }
  override willUpdate(changed: Map<string, unknown>) { if (changed.has("guid") && this.guid) this.load(); }

  private get dirty(): boolean {
    if (!this.view) return false;
    const d = this.view.data as Record<string, unknown>;
    return this.docTitle !== (d.title ?? "") || !deepEqual(this.blocks, d.content ?? []) || !deepEqual(this.fields, d.fields ?? {});
  }

  private async load() {
    const seq = ++this.loadSeq;
    const guid = this.guid;
    this.error = "";
    this.view = null;
    try {
      const view = await api.get(guid);
      if (seq !== this.loadSeq) return;
      this.view = view;
      const d = this.view.data as Record<string, unknown>;
      this.docTitle = String(d.title ?? "");
      this.blocks = structuredClone((d.content as Block[]) ?? []);
      this.fields = structuredClone((d.fields as Record<string, unknown>) ?? {});
      this.schema = (await api.schemaOf(this.guid).catch(() => ({ schema: null }))).schema;
      this.loadSide();
      this.resolveEntries();
    } catch (e) {
      this.error = e instanceof ApiError ? e.message : String(e);
    }
  }

  private async loadSide() {
    const [rel, c, h] = await Promise.all([api.relationships(this.guid).catch(() => null), api.comments(this.guid).catch(() => ({ comments: [] })), api.history(this.guid).catch(() => ({ history: [] }))]);
    this.rel = rel;
    this.comments = c.comments;
    this.history = h.history;
  }

  private resolveEntries() {
    const walk = (bs: Block[]) => {
      for (const b of bs) {
        if (b.type === "entry" && b.guid && !this.entries.has(b.guid)) {
          this.entries.set(b.guid, null);
          api.get(b.guid).then((v) => { this.entries.set(b.guid!, v.meta); this.requestUpdate(); }).catch(() => this.requestUpdate());
        }
        walk(b.children ?? []);
        walk(b.items ?? []);
      }
    };
    walk(this.blocks);
  }

  private touch() {
    if (!this.editing) { this.editing = true; announceEdit(this.guid, true); }
    this.blocks = [...this.blocks];
  }

  private async save() {
    if (!this.view || this.busy) return;
    this.busy = true;
    this.error = "";
    const d = this.view.data as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (this.docTitle !== (d.title ?? "")) patch.title = this.docTitle;
    if (!deepEqual(this.blocks, d.content ?? [])) patch.content = this.blocks;
    if (!deepEqual(this.fields, d.fields ?? {})) {
      const f: Record<string, unknown> = {};
      const old = (d.fields as Record<string, unknown>) ?? {};
      for (const [k, v] of Object.entries(this.fields)) if (!deepEqual(v, old[k])) f[k] = v ?? null;
      for (const k of Object.keys(old)) if (!(k in this.fields)) f[k] = null;
      patch.fields = f;
    }
    try {
      this.view = await api.update(this.guid, patch, this.view.etag);
      store.toast("Document saved", "success");
      if (this.editing) { announceEdit(this.guid, false); this.editing = false; }
      store.refresh();
    } catch (e) {
      this.error = e instanceof ApiError && e.status === 412 ? "Someone else modified this document. Reload to see their version." : e instanceof ApiError ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  // ---- block operations ----
  private locate(id: string, list: Block[] = this.blocks): { list: Block[]; index: number } | null {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.id === id) return { list, index: i };
      for (const kids of [b.children, b.items]) {
        if (kids) { const r = this.locate(id, kids); if (r) return r; }
      }
    }
    return null;
  }

  private insertAfter(id: string | null, block: Block) {
    block.id ??= blockId();
    const loc = id ? this.locate(id) : null;
    if (!loc) this.blocks.push(block);
    else {
      const cur = loc.list[loc.index];
      if (cur.type === "section" && cur.children && block.type !== "section") cur.children.unshift(block);
      else loc.list.splice(loc.index + 1, 0, block);
    }
    this.focused = block.id!;
    this.touch();
    this.updateComplete.then(() => this.querySelector<HTMLElement>(`[data-block="${block.id}"] .block[contenteditable]`)?.focus());
  }

  private removeBlock(id: string) {
    const loc = this.locate(id);
    if (!loc) return;
    loc.list.splice(loc.index, 1);
    this.focused = null;
    this.touch();
  }

  private moveBlock(id: string, delta: number) {
    const loc = this.locate(id);
    if (!loc) return;
    const j = loc.index + delta;
    if (j < 0 || j >= loc.list.length) return;
    [loc.list[loc.index], loc.list[j]] = [loc.list[j], loc.list[loc.index]];
    this.touch();
  }

  private indent(id: string) {
    const loc = this.locate(id);
    if (!loc || loc.index === 0) return;
    const prev = loc.list[loc.index - 1];
    if (prev.type !== "section") return;
    const [b] = loc.list.splice(loc.index, 1);
    (prev.children ??= []).push(b);
    this.touch();
  }

  private outdent(id: string) {
    // find parent section containing this block
    const find = (list: Block[], parentList: Block[] | null, parent: Block | null): boolean => {
      for (let i = 0; i < list.length; i++) {
        const b = list[i];
        if (b.id === id && parent && parentList) {
          list.splice(i, 1);
          parentList.splice(parentList.indexOf(parent) + 1, 0, b);
          return true;
        }
        if (b.children && find(b.children, list, b)) return true;
        if (b.items && find(b.items, list, b)) return true;
      }
      return false;
    };
    if (find(this.blocks, null, null)) this.touch();
  }

  private insertEntry(afterId: string | null) {
    store.set({ picker: { kind: "pick", title: "Insert entry reference", kinds: ["entry"], onPick: (s: Summary) => {
      this.entries.set(s.guid, s);
      this.insertAfter(afterId, { id: blockId(), type: "entry", guid: s.guid });
    } } });
  }

  private onKey(e: KeyboardEvent, b: Block) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this.commitText(e.target as HTMLElement, b);
      this.insertAfter(b.id!, { id: blockId(), type: b.type === "list" ? "paragraph" : "paragraph", text: "" });
    } else if (e.key === "Backspace" && (e.target as HTMLElement).textContent === "" && b.type === "paragraph") {
      e.preventDefault();
      const loc = this.locate(b.id!);
      const prev = loc && loc.index > 0 ? loc.list[loc.index - 1] : null;
      this.removeBlock(b.id!);
      if (prev?.id) this.updateComplete.then(() => this.querySelector<HTMLElement>(`[data-block="${prev.id}"] .block[contenteditable]`)?.focus());
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.commitText(e.target as HTMLElement, b);
      if (e.shiftKey) this.outdent(b.id!); else this.indent(b.id!);
    } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      this.commitText(e.target as HTMLElement, b);
      this.save();
    }
  }

  private commitText(el: HTMLElement, b: Block) {
    const text = el.innerText.replace(/\n$/, "");
    const key = b.type === "section" ? "title" : "text";
    if (b[key] !== text) { b[key] = text; this.touch(); }
  }

  private block(b: Block, depth: number): TemplateResult {
    b.id ??= blockId();
    const focused = this.focused === b.id;
    const handle = html`<div class="handle" contenteditable="false">
      <button title="Move up" @click=${() => this.moveBlock(b.id!, -1)}>▲</button><button title="Move down" @click=${() => this.moveBlock(b.id!, 1)}>▼</button>
      <button title="Indent into previous section (Tab)" @click=${() => this.indent(b.id!)}>→</button><button title="Outdent (Shift+Tab)" @click=${() => this.outdent(b.id!)}>←</button>
      <button type="button" title="Delete block" aria-label="Delete block" @click=${() => this.removeBlock(b.id!)}>✕</button></div>`;
    // The text is bound with live() so re-renders never rewrite (and thus
    // never move the caret in) a block the user is typing into.
    const editable = (cls: string, key: "title" | "text", placeholder: string) => html`<div class="block ${cls}" contenteditable="plaintext-only" data-placeholder=${placeholder} spellcheck="true"
      .textContent=${live(b[key] ?? "")}
      @focus=${() => (this.focused = b.id!)} @input=${(e: Event) => this.commitText(e.target as HTMLElement, b)}
      @blur=${(e: Event) => this.commitText(e.target as HTMLElement, b)} @keydown=${(e: KeyboardEvent) => this.onKey(e, b)}></div>`;
    let body: TemplateResult;
    switch (b.type) {
      case "section":
        body = html`${editable(`h l${Math.min(depth + 1, 3)}`, "title", "Section title")}
          <div class="section-children"><div class="blocks">${(b.children ?? []).map((c) => this.block(c, depth + 1))}</div>
          <button class="btn sm" style="margin:4px 0" @click=${() => { (b.children ??= []).push({ id: blockId(), type: "paragraph", text: "" }); this.touch(); }}>＋ paragraph in section</button></div>`;
        break;
      case "paragraph":
        body = editable("", "text", "Type text…");
        break;
      case "code":
        body = editable("code", "text", "code");
        break;
      case "list":
        body = html`<div class="blocks">${(b.items ?? []).map((c) => html`<div class="list-item">${this.block(c, depth + 1)}</div>`)}</div>`;
        break;
      case "image":
        {
          const src = safeImageSrc(b.src, (name) => api.fileUrl(this.guid, name));
          body = src ? html`<img class="doc-image" src=${src} alt=${b.alt ?? ""} /><div class="muted small">${b.alt ?? b.src}</div>`
            : html`<div class="notice error">Image source not allowed: <code>${b.src}</code></div>`;
        }
        break;
      case "entry": {
        const meta = this.entries.get(b.guid ?? "");
        body = meta ? html`<div class="entry-card" data-entry=${b.guid ?? ""} @click=${() => navigate({ guid: b.guid! })}>
            <div class="head">${kindIcon("entry")}${meta.hid ? html`<span class="hid">${meta.hid}</span>` : nothing}<b>${meta.title}</b><span class="muted small">${meta.type}</span>
              ${Object.entries(meta.workflows ?? {}).map(([, st]) => html`<span class="pill state">${st}</span>`)}</div>
            <div class="fields">${Object.entries(meta.fields ?? {}).slice(0, 6).map(([k, v]) => html`<span><b>${k}</b>: ${typeof v === "object" ? JSON.stringify(v) : String(v)}</span>`)}</div></div>`
          : html`<div class="entry-card missing" data-entry=${b.guid ?? ""}>${this.entries.has(b.guid ?? "") ? html`Entry <code>${b.guid}</code> is missing` : "Loading entry…"}</div>`;
        break;
      }
      default:
        body = html`<pre class="json">${JSON.stringify(b)}</pre>`;
    }
    return html`<div class="block-wrap ${focused ? "focused" : ""}" data-block=${b.id} data-type=${b.type} @click=${() => (this.focused = b.id!)}>${handle}${body}</div>`;
  }

  override render() {
    if (!this.view) return html`<div class="empty-state">${this.error || "Loading…"}</div>`;
    const r = this.s.route;
    const v = this.view;
    const others = (this.s.presence[this.guid]?.editors ?? []).filter((n) => n !== this.s.user);
    const after = this.focused;
    return html`
      <div class="doc-main">
        <div class="doc-toolbar">
          <button class="btn sm icon" title="Back to overview" aria-label="Back to overview" @click=${() => navigate({ guid: null, sidebars: [] })}>✕</button>
          ${v.meta.hid ? html`<span class="hid">${v.meta.hid}</span>` : nothing}
          <span class="muted small">${this.schema?.displayName ?? v.meta.type} · ${v.meta.folder || "/"}</span>
          ${others.length ? html`<span class="presence">✎ ${others.join(", ")} editing</span>` : nothing}
          <span class="sep"></span>
          <button class="btn sm" @click=${() => this.insertAfter(after, { type: "section", title: "", children: [] })}>＋ Section</button>
          <button class="btn sm" @click=${() => this.insertAfter(after, { type: "paragraph", text: "" })}>＋ Paragraph</button>
          <button class="btn sm" data-test="insert-entry" @click=${() => this.insertEntry(after)}>＋ Entry reference</button>
          <button class="btn sm" @click=${() => this.insertAfter(after, { type: "list", items: [{ id: blockId(), type: "paragraph", text: "" }] })}>＋ List</button>
          <button class="btn sm" @click=${() => this.insertAfter(after, { type: "code", text: "" })}>＋ Code</button>
          <button class="btn sm" @click=${() => store.prompt("Insert image", { text: "An attachment name of this document or an image URL.", placeholder: "diagram.png or https://…", confirmLabel: "Insert" }).then((src) => { if (src?.trim()) this.insertAfter(after, { type: "image", src: src.trim(), alt: "" }); })}>＋ Image</button>
          <span class="grow"></span>
          ${SIDEBARS.map(([id, name]) => html`<button class="chip ${r.sidebars.includes(id) ? "on" : ""}" data-test=${"sb-" + id}
            @click=${() => navigate({ sidebars: r.sidebars.includes(id) ? r.sidebars.filter((x) => x !== id) : [...r.sidebars, id] }, true)}>${name}</button>`)}
          <span class="sep"></span>
          <button class="btn primary sm" data-test="save" ?disabled=${!this.dirty || this.busy} @click=${this.save}>${this.busy ? "Saving…" : this.dirty ? "Save" : "Saved"}</button>
        </div>
        ${this.error ? html`<div class="notice error">${this.error} <button class="btn sm" @click=${this.load}>Reload</button></div>` : nothing}
        <div class="doc-scroll"><div class="doc-page">
          <h1 class="doc-title" contenteditable="plaintext-only" data-test="doc-title" @input=${(e: Event) => { this.docTitle = (e.target as HTMLElement).innerText.trim(); if (!this.editing) { this.editing = true; announceEdit(this.guid, true); } }}>${(v.data as Record<string, unknown>).title as string}</h1>
          <div class="blocks">${this.blocks.map((b) => this.block(b, 0))}</div>
          ${!this.blocks.length ? html`<div class="muted">Empty document. Add a section or paragraph from the toolbar.</div>` : nothing}
        </div></div>
      </div>
      ${r.sidebars.length ? html`<aside class="doc-side">${r.sidebars.map((id) => this.sidebar(id))}</aside>` : nothing}`;
  }

  private sidebar(id: string): TemplateResult {
    const v = this.view!;
    switch (id) {
      case "props":
        return html`<h4>Document properties</h4>
          <dl class="kv"><dt>Type</dt><dd>${v.meta.type}</dd><dt>Folder</dt><dd>${v.meta.folder || "/"}</dd><dt>GUID</dt><dd class="mono small">${v.meta.guid}</dd><dt>Modified</dt><dd>${relTime(v.meta.modifiedAt)}</dd>
            ${Object.entries(v.meta.workflows ?? {}).map(([w, st]) => html`<dt>${w}</dt><dd><span class="pill state">${st}</span></dd>`)}</dl>
          ${(this.schema?.fields ?? []).filter((f) => f.type !== "workflow").map((f) => html`<corestone-field .field=${f} .value=${this.fields[f.id]} .attachments=${v.attachments ?? []}
            @field-change=${(e: CustomEvent) => { const n = { ...this.fields }; if (e.detail.value == null) delete n[e.detail.id]; else n[e.detail.id] = e.detail.value; this.fields = n; }}></corestone-field>`)}
          <button class="btn sm" style="margin-top:8px" @click=${() => navigate({ guid: this.guid, tab: "general" }, true)}>Open as artifact detail</button>`;
      case "entry": {
        const focusedBlock = this.focused ? this.locate(this.focused)?.list[this.locate(this.focused)!.index] : null;
        const meta = focusedBlock?.type === "entry" ? this.entries.get(focusedBlock.guid ?? "") : null;
        return html`<h4>Current entry</h4>${meta ? html`<div><b>${meta.hid ?? ""}</b> ${meta.title}</div>
          <dl class="kv">${Object.entries(meta.fields ?? {}).map(([k, val]) => html`<dt>${k}</dt><dd>${typeof val === "object" ? JSON.stringify(val) : String(val)}</dd>`)}</dl>
          <button class="btn sm" @click=${() => navigate({ guid: meta.guid })}>Open entry</button>` : html`<div class="muted small">Select an entry reference in the document.</div>`}`;
      }
      case "rel":
        return html`<h4>Relationships</h4>${!this.rel || (!this.rel.incoming.length && !this.rel.outgoing.length) ? html`<div class="muted small">No links.</div>` : nothing}
          ${this.rel?.outgoing.map((l) => html`<div>→ <span class="muted small">${l.link.type}</span> <a href="#" @click=${(e: Event) => { e.preventDefault(); navigate({ guid: l.other.guid }); }}>${label(l.other)}</a></div>`)}
          ${this.rel?.incoming.map((l) => html`<div>← <span class="muted small">${l.link.type}</span> <a href="#" @click=${(e: Event) => { e.preventDefault(); navigate({ guid: l.other.guid }); }}>${label(l.other)}</a></div>`)}`;
      case "comments":
        return html`<h4>Comments</h4>${this.comments.map((c) => html`<div class="comment"><div class="who"><b>${c.meta.author}</b> · ${fmtTime(c.meta.created)}</div><div class="text">${String(c.data?.text ?? "")}</div></div>`)}
          <div class="inline-form"><textarea placeholder="Comment…" .value=${this.commentText} @input=${(e: Event) => (this.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
          <button class="btn sm primary" @click=${async () => { if (!this.commentText.trim()) return; try { await api.create("comments", { subject: this.guid, text: this.commentText, author: this.s.user }); this.commentText = ""; this.loadSide(); } catch (e) { store.toast((e as Error).message, "error"); } }}>Post</button></div>`;
      case "versions":
        return html`<h4>Versions</h4>${this.history.map((h) => html`<div class="small"><span class="muted">${fmtTime(h.time)}</span> ${h.subject} <span class="mono muted">${h.sha.slice(0, 7)}</span></div>`)}`;
    }
    return html``;
  }
}
