import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { api } from "./api";
import type { FolderInfo } from "./types";

// Folder input (design guide §7.3): folders exist only through what they
// contain, so any path may be typed — the field shows which segments exist,
// which would be created by the write, warns about near-misses of an existing
// sibling, and offers the existing hierarchy to pick from.

interface Node { info: FolderInfo; children: Node[] | null; open: boolean }
interface Segment { name: string; path: string; exists: boolean; similar?: string }

const clean = (p: string) => p.trim().replace(/\\/g, "/").split("/").map((s) => s.trim()).filter(Boolean).join("/");

/** True when a and b differ only by case or by one inserted, removed or replaced character. */
function nearMiss(a: string, b: string): boolean {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 3) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rest = (s: string, n: number) => s.slice(n);
  return rest(a, i + 1) === rest(b, i + 1) || rest(a, i) === rest(b, i + 1) || rest(a, i + 1) === rest(b, i);
}

@customElement("corestone-folder-field")
export class FolderField extends LitElement {
  @property() value = "";
  @property() inputId = "";
  @property() test = "folder";
  /** A folder that is not a typo candidate (the one being moved or renamed). */
  @property() ignore = "";
  @state() private segments: Segment[] = [];
  @state() private browsing = false;
  @state() private root: Node = { info: { name: "Repository", path: "", artifacts: 0, direct: 0, hasConfig: false }, children: null, open: true };
  private cache = new Map<string, Promise<FolderInfo[]>>();
  private timer = 0;
  private seq = 0;

  override createRenderRoot() { return this; }
  override connectedCallback() { super.connectedCallback(); this.resolve(); }
  override disconnectedCallback() { window.clearTimeout(this.timer); super.disconnectedCallback(); }

  private subfolders(path: string): Promise<FolderInfo[]> {
    let p = this.cache.get(path);
    if (!p) {
      p = api.tree(path, false, 1).then((t) => t.folders);
      p.catch(() => this.cache.delete(path));
      this.cache.set(path, p);
    }
    return p;
  }

  /** Walks the typed path from the root and marks the first missing segment and everything below it as new. */
  private async resolve() {
    const seq = ++this.seq;
    const parts = clean(this.value).split("/").filter(Boolean);
    const out: Segment[] = [];
    let exists = true;
    try {
      for (let i = 0; i < parts.length; i++) {
        const path = parts.slice(0, i + 1).join("/");
        const seg: Segment = { name: parts[i], path, exists: false };
        if (exists) {
          const siblings = await this.subfolders(parts.slice(0, i).join("/"));
          if (seq !== this.seq) return;
          seg.exists = siblings.some((f) => f.name === parts[i]);
          if (!seg.exists) seg.similar = siblings.find((f) => f.path !== this.ignore && nearMiss(f.name, parts[i]))?.name;
          exists = seg.exists;
        }
        out.push(seg);
      }
    } catch {
      return; // the server validates the path on save either way
    }
    this.segments = out;
  }

  private set(value: string, now = false) {
    this.value = value;
    this.dispatchEvent(new CustomEvent("folder-change", { detail: value }));
    window.clearTimeout(this.timer);
    if (now) this.resolve(); else this.timer = window.setTimeout(() => this.resolve(), 200);
  }

  private async load(n: Node) {
    n.children = (await this.subfolders(n.info.path).catch(() => [])).map((f) => ({ info: f, children: null, open: false }));
    this.requestUpdate();
  }

  private browse() {
    this.browsing = !this.browsing;
    if (this.browsing && !this.root.children) this.load(this.root);
  }

  private node(n: Node, depth: number): TemplateResult {
    const hasKids = n.children === null || n.children.length > 0;
    return html`<li>
      <div class="row ${clean(this.value) === n.info.path ? "selected" : ""}" data-pick=${n.info.path} @click=${() => this.set(n.info.path, true)}>
        <span class="caret ${hasKids ? "" : "empty"}" @click=${(e: Event) => { e.stopPropagation(); n.open = !n.open; if (n.open && !n.children) this.load(n); this.requestUpdate(); }}>${n.open ? "▾" : "▸"}</span>
        <span class="name">${depth === 0 ? html`<b>${n.info.name}</b>` : n.info.name}</span>
        ${n.info.artifacts ? html`<span class="count">${n.info.artifacts}</span>` : nothing}
      </div>
      ${n.open && n.children?.length ? html`<ul>${n.children.map((c) => this.node(c, depth + 1))}</ul>` : nothing}
    </li>`;
  }

  private status() {
    const fresh = this.segments.filter((s) => !s.exists);
    if (!fresh.length) return nothing;
    const typo = fresh[0].similar;
    const parent = fresh[0].path.split("/").slice(0, -1);
    const fixed = [...parent, typo, ...fresh.slice(1).map((s) => s.name)].join("/");
    return html`<div class="folder-status" data-test="folder-status">
      <span class="pill new">new folder</span>
      <span class="folder-path">${this.segments.map((s, i) => html`${i ? "/" : nothing}<span class=${s.exists ? "" : "new"}>${s.name}</span>`)}</span>
      <span class="muted">does not exist yet — it is created on save.</span>
      ${typo ? html`<div class="folder-typo" data-test="folder-typo">A folder <b>${typo}</b> already exists here.
        <button type="button" class="btn sm" @click=${() => this.set(fixed, true)}>Use ${typo}</button></div>` : nothing}
    </div>`;
  }

  override render() {
    return html`<div class="folder-field">
      <div class="folder-input">
        <input id=${this.inputId} type="text" data-test=${this.test} .value=${this.value} placeholder="(repository root)" autocomplete="off"
          @input=${(e: Event) => this.set((e.target as HTMLInputElement).value)} />
        <button type="button" class="btn sm" data-test="folder-browse" aria-expanded=${this.browsing} @click=${() => this.browse()}>${this.browsing ? "Hide" : "Browse…"}</button>
      </div>
      ${this.status()}
      ${this.browsing ? html`<div class="folder-browser"><ul class="tree">${this.node(this.root, 0)}</ul>
        <div class="help">Pick an existing folder, then append <code>/name</code> above for a new subfolder.</div></div>` : nothing}
    </div>`;
  }
}
