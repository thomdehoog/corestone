import { html, nothing, type TemplateResult } from "lit";
import { deepEqual, drag, DropMenu, errorText, fmtSize, fmtTime, LightElement, prefs, section } from "@corestone/ui";
import { customElement, property, state } from "lit/decorators.js";
import type { EntryFiles } from "@corestone/editor";
import { api, ApiError, type SaveChanges, type SaveConflict, type SaveConflictItem } from "./api";
import { clearLeaveGuard, navigate, setLeaveGuard, type LeaveGuard } from "./router";
import { MAX_ATTACHMENT, freeFileName } from "./files";
import { store, type Route, type State, toastError } from "./store";
import type { Attachment, CommentView, Field, HistoryEntry, OverlayView, PickerAction, Relationships, Schema, Summary, VersionView, View, WorkflowEval, WorkflowValue } from "./types";
import { announceEdit } from "./ws";
import { commentTypeOf, hidLabel, isWorkflowValue, label, showValue, undeclaredField } from "./components/util";
import "./components/type-icon";
import "./components/table";
import type { TableColumn } from "./components/table";
import "./components/fields";
import { OVERLAY_HELP, type OverlayState } from "./components/fields";

// Entry detail view (design guide §7.5): one scrollable page with every
// section the effective schema implies, quick links to sections, and an
// optimistic-concurrency save (ETag / If-Match).
//
// With a version (?version=<blob>&at=<commit>) it shows the artifact as it
// was at that commit (TSK-22): read-only, marked historic (sepia), with the
// links, comments, attachments and base chain of then; configuration is
// today's.

/** Changes besides fields that wait for Save, published together in one commit. */
interface Pending {
  /** Workflow field id → the transition chosen and the state it leads to. */
  transitions: Record<string, { transition: string; state: string }>;
  links: { type: string; source: string; target: string; other: Summary; role: string; dir: "in" | "out" }[];
  removedLinks: string[];
  comments: { type: string | null; text: string; parent?: string }[];
  files: File[];
  removedFiles: string[];
}
const noPending = (): Pending => ({ transitions: {}, links: [], removedLinks: [], comments: [], files: [], removedFiles: [] });

const SECTIONS = ["comment", "fields", "relationships", "comments", "overlay", "attachments", "documents", "history", "metadata"] as const;
type Section = (typeof SECTIONS)[number];
const OPEN_KEY = "corestone.detail.sections";

function readOpenPrefs(): Record<string, boolean> {
  return prefs.json<Record<string, boolean>>(OPEN_KEY, {}, { session: true });
}

/** The height the user dragged a resizable area to (per name), if any. */
const heightKey = (name: string) => `corestone.height.${name}`;
function savedHeight(name: string): string {
  const h = Number(prefs.text(heightKey(name)));
  return h > 0 ? `height:${h}px` : "";
}

/** Drags the bottom edge of the area before the grip; double-click goes back to the default. */
function heightGrip(name: string) {
  const start = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    const area = grip.previousElementSibling as HTMLElement;
    const h0 = area.getBoundingClientRect().height, y0 = e.clientY;
    let h = h0;
    drag(e, {
      move: (m) => { h = Math.round(Math.max(60, h0 + m.clientY - y0)); area.style.height = `${h}px`; area.style.maxHeight = "none"; },
      end: () => prefs.setText(heightKey(name), String(h)),
    });
  };
  const reset = (e: Event) => {
    const area = (e.currentTarget as HTMLElement).previousElementSibling as HTMLElement;
    area.style.height = area.style.maxHeight = "";
    prefs.remove(heightKey(name));
  };
  return html`<div class="height-grip" data-test=${`${name}-resize`} title="Drag to resize, double-click to reset"
    @pointerdown=${start} @dblclick=${reset}></div>`;
}

@customElement("corestone-detail")
export class Detail extends LightElement {
  @property() guid = "";
  /** A historic version to show: the content blob and the commit it is viewed at ("" = current). */
  @property() version = "";
  @property() at = "";
  /** The loaded historic version; null while showing the current state. */
  @state() private historic: VersionView | null = null;
  private unsub?: () => void;
  private s!: State;
  @state() private view: View | null = null;
  @state() private schema: Schema | null = null;
  @state() private workflows: WorkflowEval[] = [];
  @state() private rel: Relationships | null = null;
  /** For a link: the artifacts it connects (null when an endpoint no longer exists). */
  @state() private endpoints: { source: Summary | null; target: Summary | null } | null = null;
  /** For a comment: what it is on; a link subject comes with its endpoints and role name. */
  @state() private subject: { meta: Summary; source?: Summary | null; target?: Summary | null; role?: string } | null = null;
  /** The comment thread shown here; for a comment, the whole thread of its subject. */
  @state() private comments: CommentView[] = [];
  @state() private overlay: OverlayView | null = null;
  @state() private documents: Summary[] = [];
  /** The base's effective fields: what this entry shows where it sets nothing itself. */
  @state() private baseOverlay: OverlayView | null = null;
  /** The comment type to post with here; null when the folder defines none (no comments then). */
  @state() private commentType: string | null = null;
  @state() private history: HistoryEntry[] = [];
  /** Older history entries remain to be loaded. */
  @state() private historyMore = false;
  @state() private draft: { title: string; hid: string; fields: Record<string, unknown> } | null = null;
  @state() private pending: Pending = noPending();
  @state() private busy = false;
  @state() private error = "";
  @state() private loading = true;
  @state() private replyTo: string | null = null;
  @state() private commentText = "";
  @state() private showDiagram: string | null = null;
  @state() private historyLoaded = false;
  private readonly actions = new DropMenu({
    label: "Actions", cls: "actions-pop", align: "end",
    items: () => [
      { label: "Move…", test: "move", run: () => this.move() },
      { label: "Delete", test: "delete", danger: true, run: () => this.deleteArtifact() },
    ],
  });
  /** A base change shown for review: the new base (null removes it) and that base's effective fields. */
  @state() private baseChange: { to: Summary | null; next: OverlayView | null; keep: boolean } | null = null;
  /** A new base being set up from fields this entry sets itself: its title and the fields that move. */
  @state() private underlay: { title: string; fields: Set<string> } | null = null;
  /** Sections the user opened or closed; remembered for the browser session. */
  @state() private openPrefs: Record<string, boolean> = readOpenPrefs();
  /** Toggles of changed sections while viewing one historic version; not persisted. */
  @state() private versionOpen: Record<string, boolean> = {};
  private lastTick = -1;
  private editing = false;
  private loadSeq = 0;
  private softInFlight = false;
  private softPending = false;

  /** Asked by the router before leaving this artifact with unsaved changes. */
  private leaveGuard: LeaveGuard = {
    dirty: () => this.dirty,
    save: async () => { await this.save(); return !this.dirty; },
    discard: () => { if (this.view) this.resetDraft(); },
    label: () => (this.view ? hidLabel(this.view.meta) : "This artifact"),
  };

  override connectedCallback() {
    super.connectedCallback();
    setLeaveGuard(this.leaveGuard);
    this.unsub = store.subscribe((s) => {
      this.s = s;
      if (s.refreshTick !== this.lastTick) {
        this.lastTick = s.refreshTick;
        if (this.view && !this.version) this.reload(true); // a version does not change
      }
      this.requestUpdate();
    });
  }
  override disconnectedCallback() { this.unsub?.(); this.actions.close(); clearLeaveGuard(this.leaveGuard); if (this.editing) announceEdit(this.guid, false); super.disconnectedCallback(); }
  override willUpdate(changed: Map<string, unknown>) {
    if ((changed.has("guid") || changed.has("version") || changed.has("at")) && this.guid) {
      // A deep link to a section (?tab=history) opens it.
      const tab = store.state.route.tab;
      if ((SECTIONS as readonly string[]).includes(tab)) this.setOpen(tab as Section, true, false);
      this.draft = null; this.reload(false);
    }
  }

  override updated() { this.classList.toggle("historic", !!this.historic); }

  private get dirty(): boolean {
    if (!this.draft || !this.view || this.historic) return false;
    return this.fieldsDirty || this.pendingCount > 0;
  }

  /** The edited title, HID and fields that differ from the stored ones. */
  private get edited(): string[] {
    const d = this.view!.data as Record<string, unknown>;
    return [
      ...(this.draft!.title !== (d.title ?? "") ? ["title"] : []),
      ...(this.draft!.hid !== (d.hid ?? "") ? ["HID"] : []),
      ...(!deepEqual(this.draft!.fields, d.fields ?? {}) ? ["fields"] : []),
    ];
  }

  private get fieldsDirty(): boolean { return this.edited.length > 0; }

  private get pendingCount(): number {
    const p = this.pending;
    return Object.keys(p.transitions).length + p.links.length + p.removedLinks.length + p.comments.length + p.files.length + p.removedFiles.length;
  }

  /** What Save will publish, for the save bar. */
  private pendingSummary(): string {
    const p = this.pending;
    const n = (k: number, one: string, many = one + "s") => (k ? [`${k} ${k === 1 ? one : many}`] : []);
    return [
      ...this.edited,
      ...n(Object.keys(p.transitions).length, "transition"),
      ...n(p.links.length, "link added", "links added"),
      ...n(p.removedLinks.length, "link removed", "links removed"),
      ...n(p.comments.length, "comment"),
      ...n(p.files.length, "attachment added", "attachments added"),
      ...n(p.removedFiles.length, "attachment removed", "attachments removed"),
    ].join(", ");
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
    if (!soft) { this.loading = true; this.view = null; this.draft = null; this.pending = noPending(); this.schema = null; this.overlay = null; this.baseOverlay = null; this.documents = []; this.rel = null; this.endpoints = null; this.subject = null; this.comments = []; this.history = []; this.historyMore = false; this.historyLoaded = false; this.workflows = []; this.historic = null; this.actions.close(); this.baseChange = null; this.underlay = null; }
    this.error = "";
    try {
      if (this.version) return await this.loadVersion(guid, stale);
      const view = await api.get(guid);
      if (stale()) return;
      const isLink = view.meta.kind === "link";
      const isComment = view.meta.kind === "comment";
      const endpoint = (g?: string) => g ? api.get(g).then((e) => e.meta).catch(() => null) : Promise.resolve(null);
      const subjectOf = async (g?: string) => {
        const meta = await endpoint(g);
        if (!meta || meta.kind !== "link") return meta ? { meta } : null;
        const [source, target, role] = await Promise.all([endpoint(meta.source), endpoint(meta.target),
          api.schemaOf(meta.guid).then((s) => s.schema?.displayName).catch(() => undefined)]);
        return { meta, source, target, role };
      };
      const [schema, wf, rel, endpoints, subject, comments, history, overlay, baseOverlay, documents, types] = await Promise.all([
        api.schemaOf(guid).catch(() => ({ schema: null })),
        api.workflows(guid).catch(() => ({ workflows: [] })),
        isLink || isComment ? Promise.resolve(null) : api.relationships(guid).catch(() => null),
        isLink ? Promise.all([endpoint(view.meta.source), endpoint(view.meta.target)]) : Promise.resolve(null),
        isComment ? subjectOf(view.meta.subject) : Promise.resolve(null),
        // Replies share the root subject, so a comment shows the thread it belongs to.
        api.comments(isComment ? view.meta.subject ?? guid : guid).catch(() => ({ comments: [] })),
        // History is only fetched while its section is open.
        this.isOpen("history") ? api.history(guid).catch(() => ({ history: [], more: false })) : Promise.resolve(null),
        view.meta.kind === "entry" ? api.overlay(guid).catch(() => null) : Promise.resolve(null),
        view.meta.kind === "entry" && view.meta.base ? api.overlay(view.meta.base).catch(() => null) : Promise.resolve(null),
        view.meta.kind === "entry" ? api.documents(guid).catch(() => ({ documents: [] })) : Promise.resolve({ documents: [] }),
        api.types(view.meta.folder).catch(() => ({ types: [] })),
      ]);
      if (stale()) return;
      // Judge the draft against the view it was made from, after every
      // await: typing that happened during the fetches must survive.
      const wasDirty = this.dirty;
      if (soft && wasDirty && view.etag !== this.view?.etag) {
        // Keep the draft and the version it started from: Save merges the
        // edits into the newer version and asks only if both changed the same thing.
        this.loading = false;
        return;
      }
      this.view = view;
      this.schema = schema.schema;
      this.workflows = wf.workflows;
      this.rel = rel;
      this.endpoints = endpoints ? { source: endpoints[0], target: endpoints[1] } : null;
      this.subject = subject;
      this.comments = comments.comments;
      this.history = history?.history ?? [];
      this.historyMore = history?.more ?? false;
      this.historyLoaded = !!history;
      this.overlay = overlay;
      this.baseOverlay = baseOverlay;
      this.documents = documents.documents;
      this.commentType = commentTypeOf(types.types);
      if (!this.draft || !wasDirty) this.resetDraft(); // an untouched draft follows the new version
      // A deep link to a section (?tab=comments) also scrolls to it once the view is there.
      const tab = store.state.route.tab;
      if (!soft && this.sectionOrder().includes(tab as Section)) void this.reveal(tab as Section);
    } catch (e) {
      if (stale()) return;
      this.error = errorText(e);
      if (!soft) this.view = null;
    } finally {
      if (!stale()) this.loading = false;
    }
  }

  /** A historic version: everything about the artifact comes from that commit, read-only. */
  private async loadVersion(guid: string, stale: () => boolean) {
    const v = await api.version(guid, this.version, this.at);
    if (stale()) return;
    const history = this.isOpen("history") ? await api.history(guid).catch(() => ({ history: [], more: false })) : null;
    if (stale()) return;
    this.historic = v;
    this.versionOpen = {};
    this.view = v;
    this.schema = v.schema ?? null;
    this.workflows = v.workflows;
    this.rel = v.meta.kind === "link" || v.meta.kind === "comment" ? null : v.relationships;
    // A link's endpoints and a comment's subject come as they were then.
    this.endpoints = v.endpoints ?? null;
    this.subject = v.subject ?? null;
    this.comments = v.comments;
    this.overlay = v.overlay ? { ...v.overlay, overlays: [] } : null;
    this.baseOverlay = v.baseOverlay ? { ...v.baseOverlay, overlays: [] } : null;
    this.documents = [];
    this.commentType = null;
    this.history = history?.history ?? [];
    this.historyMore = history?.more ?? false;
    this.historyLoaded = !!history;
    this.resetDraft();
  }

  /** Whether the historic version shown changed a stored property (title, fields.<id>, …). */
  private changed(key: string) { return !!this.historic?.change?.changed.includes(key); }
  private changedClass(key: string) { return this.changed(key) ? "changed" : ""; }
  /** Whether the historic version shown added this link or comment. */
  private added(guid: string) { return !!this.historic?.change?.added.includes(guid); }

  /** What the historic version shown changed in a section, as short badges for its heading. */
  private sectionChange(s: Section): string[] {
    const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
    if (!this.historic) return this.pendingChange(s, plural);
    const c = this.historic.change;
    if (!c) return [];
    const added = (guids: string[]) => guids.filter((g) => c.added.includes(g)).length;
    switch (s) {
      case "fields": return c.changed.some((k) => k.startsWith("fields.")) ? ["changed"] : [];
      case "comment": return this.changed("text") ? ["changed"] : [];
      case "relationships": {
        if (this.view?.meta.kind === "link") return this.changed("source") || this.changed("target") ? ["changed"] : [];
        const n = added([...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])].map((r) => r.link.guid));
        return [...(n ? [`${plural(n, "link")} added`] : []), ...(c.removedLinks ? [`${plural(c.removedLinks, "link")} removed`] : [])];
      }
      case "comments": {
        const n = added(this.comments.map((x) => x.meta.guid));
        return [...(n ? [`${plural(n, "comment")} added`] : []), ...(c.removedComments ? [`${plural(c.removedComments, "comment")} removed`] : [])];
      }
      default: return [];
    }
  }

  /** The same badges for what waits for Save. */
  private pendingChange(s: Section, plural: (n: number, what: string) => string): string[] {
    const p = this.pending;
    const badges = (n: number, what: string, verb: string) => (n ? [`${plural(n, what)} ${verb}`] : []);
    switch (s) {
      case "fields": return (this.draft && this.view && this.edited.includes("fields")) || Object.keys(p.transitions).length ? ["changed"] : [];
      case "relationships": return [...badges(p.links.length, "link", "added"), ...badges(p.removedLinks.length, "link", "removed")];
      case "comments": return badges(p.comments.length, "comment", "added");
      case "attachments": return [...badges(p.files.length, "attachment", "added"), ...badges(p.removedFiles.length, "attachment", "removed")];
      default: return [];
    }
  }

  /** The banner of a historic version: when, by whom, and the way back. */
  private historicBanner() {
    const h = this.historic!;
    const back = () => navigate({ version: "", at: "" });
    return html`<div class="historic-banner" role="status" data-test="historic-banner">
      <span class="hb-label">Historic version</span>
      ${h.change?.created ? html`<span class="pill" data-test="historic-created">Created</span>` : h.change?.restored ? html`<span class="pill" data-test="historic-restored">Restored</span>` : nothing}
      <span>${fmtTime(h.commit.time)} · ${h.commit.author} · <span title=${h.commit.body ?? ""}>${h.commit.subject}</span></span>
      <span class="mono muted small" title="Content blob ${h.etag} at commit ${h.commit.sha}">${h.etag.slice(0, 8)} @ ${h.commit.sha.slice(0, 8)}</span>
      ${h.exact ? nothing : html`<span class="small" data-test="historic-inexact">The requested commit is unknown; shown at the commit that introduced this version.</span>`}
      <span class="small muted">Read-only. Fields and link roles are shown with today's configuration.</span>
      <span class="spacer"></span>
      ${h.exists ? html`<button class="btn sm" data-test="historic-back" @click=${back}>Back to current</button>`
        : html`<span class="small" data-test="historic-deleted">This artifact has been deleted since.</span>`}
    </div>`;
  }

  private resetDraft() {
    const d = this.view!.data as Record<string, unknown>;
    this.draft = { title: String(d.title ?? ""), hid: String(d.hid ?? ""), fields: structuredClone((d.fields as Record<string, unknown>) ?? {}) };
    this.pending = noPending();
    if (this.editing) { announceEdit(this.guid, false); this.editing = false; }
  }

  /** The entry's files for images and file links in rich text: the stored ones and the ones
   *  waiting for Save (a new one joins the pending attachments, shown from the browser until
   *  it is saved). */
  private readonly blobUrls = new WeakMap<File, string>();
  private readonly entryFiles: EntryFiles = {
    add: async (file, replace) => {
      if (file.size > MAX_ATTACHMENT) throw new Error(`it is larger than ${MAX_ATTACHMENT >> 20} MiB`);
      // replace: under its own name, in place of the stored or pending file (Save overwrites it)
      const name = replace ? file.name : freeFileName(file, new Set(await this.entryFiles.list()));
      const f = name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
      this.pending = { ...this.pending, files: [...this.pending.files.filter((p) => p.name !== name), f],
        removedFiles: this.pending.removedFiles.filter((n) => n !== name) };
      this.setOpen("attachments", true, false); // as an upload there does: what Save will store shows
      this.touched();
      return name;
    },
    // a pending file is dropped, a stored one is removed with Save
    remove: (name) => {
      const p = this.pending;
      if (p.files.some((f) => f.name === name)) this.pending = { ...p, files: p.files.filter((f) => f.name !== name) };
      else if ((this.view?.attachments ?? []).some((a) => a.name === name) && !p.removedFiles.includes(name)) {
        this.pending = { ...p, removedFiles: [...p.removedFiles, name] };
        this.touched();
      }
    },
    url: (name) => {
      const p = this.pending.files.find((f) => f.name === name);
      if (p) {
        let u = this.blobUrls.get(p);
        if (!u) { u = URL.createObjectURL(p); this.blobUrls.set(p, u); }
        return u;
      }
      const h = this.historic;
      return h ? api.versionFileUrl(this.guid, h.etag, h.commit.sha, name) : api.fileUrl(this.guid, name);
    },
    list: async () => [...new Set([
      ...(this.view?.attachments ?? []).map((a) => a.name).filter((n) => !this.pending.removedFiles.includes(n)),
      ...this.pending.files.map((f) => f.name)])],
    // a file's bytes: a pending one from the browser, else from the server
    get: async (name) => {
      const p = this.pending.files.find((f) => f.name === name);
      if (p) return p;
      return api.fileBlob(this.entryFiles.url(name));
    },
  };

  private touched() {
    if (this.historic) return; // read-only: nobody is editing
    if (!this.editing) { this.editing = true; announceEdit(this.guid, true); }
  }

  private async save(overwrite?: string) {
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
    const p = this.pending;
    const changes: SaveChanges = {
      patch,
      transitions: Object.entries(p.transitions).map(([field, t]) => ({ field, transition: t.transition })),
      addLinks: p.links.map(({ type, source, target }) => ({ type, source, target })),
      removeLinks: p.removedLinks.map((guid) => ({ guid, etag: this.linkEtag(guid) })),
      addComments: p.comments.map((c) => ({ ...c, author: this.s.user })),
      removeFiles: p.removedFiles,
      ...(overwrite ? { overwrite } : {}),
    };
    try {
      this.view = await api.save(this.guid, changes, p.files, this.view.etag);
      store.toast("Saved", "success");
      this.resetDraft();
      this.commentText = "";
      this.replyTo = null;
      this.reload(true);
      store.refresh();
    } catch (e) {
      const conflict = e instanceof ApiError && e.status === 412 ? (e.body as Partial<SaveConflict>) : null;
      if (conflict?.conflicts?.length && conflict.etag) {
        this.conflictDialog(conflict as SaveConflict);
      } else if (e instanceof ApiError && e.status === 412) {
        this.error = "Someone else modified this artifact in the meantime. Reload to see their changes; your edits stay in the form until you do.";
      } else if (e instanceof ApiError && e.status === 404) {
        store.set({ dialog: { kind: "confirm", title: "Deleted meanwhile", noConfirm: true,
          text: `${label(this.view.meta)} was deleted by someone else while you were editing. Your changes cannot be saved; they stay in the form until you leave.` } });
      } else {
        this.error = errorText(e);
      }
    } finally {
      this.busy = false;
    }
  }

  /** The version of a link as the user saw it, for removing it. */
  private linkEtag(guid: string): string | undefined {
    return [...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])].find((r) => r.link.guid === guid)?.link.etag;
  }

  /** Both changed the same things: name them, then cancel or overwrite exactly that version. */
  private conflictDialog(c: SaveConflict) {
    const v = this.view!;
    const fmt = (x: unknown) => x === undefined || x === null || x === "" ? html`<span class="muted">empty</span>`
      : html`<span class="pre-line">${showValue(x)}</span>`;
    const row = (it: SaveConflictItem) => html`<tr data-test="conflict-row">
      <th>${this.conflictLabel(it.key)}</th>
      <td>${fmt(it.theirs)}<div class="muted small">${it.author ?? "someone"}${it.time ? html` · ${fmtTime(it.time)}` : nothing}</div></td>
      <td>${fmt(it.mine)}</td></tr>`;
    store.set({ dialog: { kind: "confirm", title: "Changed by someone else", danger: true, confirmLabel: "Overwrite", resizable: "conflict",
      text: `While you were editing ${label(v.meta)}, someone else changed the same things. Your other changes merge without loss.`,
      body: html`<p><a href=${`/artifact/${v.meta.guid}`} target="_blank" rel="noopener" data-test="conflict-current">Open the current version in a new tab</a></p>
        <table class="base-diff conflict-table" data-test="conflicts"><thead><tr><th></th><th>Theirs (now)</th><th>Yours</th></tr></thead>
        <tbody>${c.conflicts.map(row)}</tbody></table>`,
      onConfirm: () => void this.save(c.etag) } });
  }

  private conflictLabel(key: string): string {
    const [kind, ...rest] = key.split(".");
    const id = rest.join(".");
    switch (kind) {
      case "fields": return this.schema?.fields?.find((f) => f.id === id)?.name ?? id;
      case "files": return `Attachment ${id}`;
      case "links": {
        const r = [...(this.rel?.incoming ?? []), ...(this.rel?.outgoing ?? [])].find((x) => x.link.guid === id);
        return r ? `Link ${r.role ?? r.link.type ?? ""} ${hidLabel(r.other)}` : "Link";
      }
      default: return key === "hid" ? "HID" : key.charAt(0).toUpperCase() + key.slice(1);
    }
  }

  /** A transition waits for Save; choosing again replaces it, choosing none drops it. */
  private transition(field: string, id: string) {
    const t = this.workflows.find((x) => x.id === field)?.available.find((x) => x.id === id);
    const transitions = { ...this.pending.transitions };
    if (!t) delete transitions[field];
    else transitions[field] = { transition: t.id, state: t.to };
    this.pending = { ...this.pending, transitions };
    this.touched();
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
        } catch (e) { toastError(e); }
      } } });
  }

  /**
   * Posting publishes the comment at once when nothing else waits for Save;
   * otherwise it joins the pending changes and is saved with them.
   */
  private async addComment() {
    if (!this.commentText.trim()) return;
    // A comment's subject is always the root artifact; here, replying defaults to the comment shown.
    const onComment = this.view?.meta.kind === "comment";
    const subject = onComment ? this.view?.meta.subject ?? this.guid : this.guid;
    const parent = this.replyTo ?? (onComment ? this.guid : undefined);
    if (this.dirty) {
      this.pending = { ...this.pending, comments: [...this.pending.comments, { type: this.commentType, text: this.commentText, parent }] };
      this.commentText = "";
      this.replyTo = null;
      this.touched();
      return;
    }
    try {
      await api.create("comments", { subject, parent, type: this.commentType, text: this.commentText, author: this.s.user });
      this.commentText = "";
      this.replyTo = null;
      this.reload(true);
      store.refresh();
    } catch (e) { toastError(e); }
  }

  /** A new link waits for Save. */
  private addLink(asSource: boolean, type: string, role: string, types?: string[]) {
    store.set({ picker: { kind: "pick", title: asSource ? `${type}: choose target` : `${type}: choose source`, types, exclude: this.guid, kinds: ["entry", "document"],
      onPick: (other: Summary) => {
        const link = asSource ? { type, source: this.guid, target: other.guid } : { type, source: other.guid, target: this.guid };
        const all = [...(this.rel?.outgoing ?? []), ...(this.rel?.incoming ?? [])].filter((l) => !this.pending.removedLinks.includes(l.link.guid));
        if (all.some((l) => l.link.type === type && l.link.source === link.source && l.link.target === link.target)
          || this.pending.links.some((l) => l.type === type && l.source === link.source && l.target === link.target)) {
          store.toast(`This ${type} link already exists`, "error");
          return;
        }
        this.pending = { ...this.pending, links: [...this.pending.links, { ...link, other, role, dir: asSource ? "out" : "in" }] };
        this.setOpen("relationships", true, false);
        this.touched();
      } } });
  }

  /** Removing a stored link waits for Save; removing a pending one drops it. */
  private toggleLinkRemoval(guid: string) {
    const removed = this.pending.removedLinks;
    this.pending = { ...this.pending, removedLinks: removed.includes(guid) ? removed.filter((g) => g !== guid) : [...removed, guid] };
    this.touched();
  }

  /** An upload waits for Save; one with the name of a stored file replaces it. */
  private upload(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    if (!files.length) return;
    const names = new Set(files.map((f) => f.name));
    this.pending = { ...this.pending,
      files: [...this.pending.files.filter((f) => !names.has(f.name)), ...files],
      removedFiles: this.pending.removedFiles.filter((n) => !names.has(n)) };
    this.setOpen("attachments", true, false);
    this.touched();
  }

  private toggleFileRemoval(name: string) {
    const removed = this.pending.removedFiles;
    this.pending = { ...this.pending, removedFiles: removed.includes(name) ? removed.filter((n) => n !== name) : [...removed, name] };
    this.touched();
  }

  private move() {
    store.prompt("Move artifact", { text: "Target folder; leave empty for the repository root.", value: this.view?.meta.folder ?? "", confirmLabel: "Move", folder: true }).then((folder) => {
      if (folder === null) return;
      api.move(this.guid, folder).then((v) => { this.view = v; store.toast(`Moved to ${folder || "/"}`, "success"); store.refresh(); navigate({ folder }); this.reload(true); })
        .catch((e) => toastError(e));
    });
  }

  private createOverlay() {
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
    const r = this.s.route;
    const order = this.sectionOrder();
    const active = r.tab || order[0];
    const body: Record<Section, () => unknown> = {
      comment: () => this.ownCommentSection(),
      fields: () => this.fieldsSection(),
      relationships: () => this.relSection(),
      comments: () => this.commentSection(),
      overlay: () => this.overlaySection(),
      attachments: () => this.attachmentSection(),
      documents: () => this.documentSection(),
      history: () => this.historySection(),
      metadata: () => this.metadataSection(),
    };
    return html`
      ${this.header()}
      <div class="detail-body">
        <nav class="quicklinks">${order.map((s) => html`<a href="#" class=${active === s ? "active" : ""} @click=${(e: Event) => { e.preventDefault(); navigate({ tab: s }, true); this.reveal(s); }}>${this.sectionName(s)}<span class="n">${this.sectionCount(s)}</span></a>`)}</nav>
        <div class="sections">
          ${this.error ? html`<div class="notice error" role="alert">${this.error} ${this.error.includes("Reload") ? html`<button class="btn sm" @click=${() => { this.draft = null; this.reload(false); }}>Reload</button>` : nothing}</div>` : nothing}
          ${order.map((s) => body[s]())}
        </div>
      </div>
      ${this.dirty ? html`<div class="savebar"><span class="dirty" data-test="unsaved-summary">Unsaved changes: ${this.pendingSummary()}</span>
        <button class="btn" @click=${() => this.resetDraft()}>Discard</button>
        <button class="btn primary" data-test="save" ?disabled=${this.busy} @click=${this.save}>${this.busy ? "Saving…" : "Save"}</button></div>` : nothing}`;
  }

  /** Three lines: dates and actions, the editable identity, the folder breadcrumb. */
  private header() {
    const v = this.view!;
    const d = this.draft!;
    const r = this.s.route;
    const presence = this.s.presence[this.guid];
    const others = presence ? [...presence.editors].filter((n) => n !== this.s.user) : [];
    const typeName = this.schema?.displayName ?? v.meta.type;
    const hidCfg = this.schema?.hid;
    const hidHint = hidCfg?.prefix ? hidCfg.prefix + (hidCfg.separator ?? "-") : "HID";
    const ov = this.overlay;
    const base = ov && ov.chain.length > 1 ? ov.chain[ov.chain.length - 2] : null;
    const overlays = ov?.overlays.length ?? 0;
    const segs = v.meta.folder ? v.meta.folder.split("/") : [];
    const toFolder = (folder: string) => (e: Event) => { e.preventDefault(); navigate({ folder, guid: null }); };
    return html`<div class="detail-head">
      <div class="dh-top">
        <span class="dh-dates">created: ${fmtTime(v.meta.createdAt)}<span class="gap"></span>updated: ${fmtTime(v.meta.modifiedAt)}</span>
        <span class="dh-actions" ?hidden=${!!this.historic}>
          <button class="btn sm icon" data-test="actions" title="Actions" aria-label="Actions" aria-haspopup="menu" aria-expanded="false"
            @click=${(e: Event) => this.actions.toggle(e.currentTarget as HTMLElement)}>⋯</button>
        </span>
      </div>
      <div class="dh-title">
        <div class="dh-identity">
        <corestone-type-icon .kind=${v.meta.kind} .type=${v.meta.type} .folder=${v.meta.folder} .schema=${this.schema} title=${typeName}></corestone-type-icon>
        ${v.meta.kind === "comment" ? html`<h2 class="dh-static" data-test="comment-heading">${typeName} by ${v.meta.author || "anonymous"}</h2>` : html`
        <input class="hid-input ${d.hid ? "" : "empty"} ${this.changedClass("hid")}" type="text" data-test="hid" aria-label="HID" .value=${d.hid} placeholder=${hidHint} ?readonly=${!!this.historic}
          size=${Math.max((d.hid || hidHint).length, 3)}
          title="Human-readable identifier; must be unique. Previous HIDs stay resolvable through history." @focus=${this.touched}
          @input=${(e: Event) => { this.draft = { ...d, hid: (e.target as HTMLInputElement).value }; }} />
        ${d.hid ? html`<span class="dash">–</span>` : nothing}
        <h2><input class="title-input ${this.changedClass("title")}" type="text" data-test="title" aria-label="Title" .value=${d.title} placeholder=${"untitled " + v.meta.kind} ?readonly=${!!this.historic} @focus=${this.touched}
          @input=${(e: Event) => { this.draft = { ...d, title: (e.target as HTMLInputElement).value }; }} /></h2>`}
        </div>
        ${others.length ? html`<span class="presence" title="concurrent editing">✎ ${others.join(", ")} editing</span>` : nothing}
        ${base ? html`<button class="pill badge" data-test="badge-overlay" @click=${() => this.reveal("overlay")}>overlay of ${this.levelLabel(base.guid)}</button>` : nothing}
        ${overlays ? html`<button class="pill badge" data-test="badge-overlays" @click=${() => this.reveal("overlay")}>${overlays} overlay${overlays === 1 ? "" : "s"}</button>` : nothing}
        <button class="btn sm" title=${r.expanded ? "Restore layout" : "Expand detail"} @click=${() => navigate({ expanded: !r.expanded })}>${r.expanded ? "⤡" : "⤢"}</button>
        <button class="btn sm icon" title="Close" aria-label="Close detail view" @click=${() => navigate({ guid: null, tab: "", expanded: false })}>✕</button>
      </div>
      <nav class="dh-crumbs" aria-label="Folder">
        <a href="/folder/" @click=${toFolder("")}>/</a>
        ${segs.map((s, i) => { const path = segs.slice(0, i + 1).join("/"); return html`${i ? html`<span class="sep">›</span>` : nothing}<a href=${"/folder/" + path} @click=${toFolder(path)}>${s}</a>`; })}
      </nav>
      ${this.historic ? this.historicBanner() : nothing}
    </div>`;
  }

  /** A link is about the relation it expresses, so its endpoints come before its fields. Comments cannot be linked. */
  private sectionOrder(): Section[] {
    const order: readonly Section[] = this.view?.meta.kind === "link"
      ? ["relationships", "fields", ...SECTIONS.filter((s) => s !== "relationships" && s !== "fields")]
      : SECTIONS;
    return order.filter((s) => this.hasSection(s));
  }

  private hasSection(s: string): boolean {
    const k = this.view?.meta.kind;
    switch (s) {
      case "comment": return k === "comment";
      case "relationships": return k !== "comment";
      case "attachments": return k === "entry" || k === "document";
      case "documents": return k === "entry" && !this.historic;
      case "overlay": return !!this.overlay;
      default: return true;
    }
  }
  private isEmpty(s: Section): boolean {
    switch (s) {
      case "fields": return !(this.schema?.fields ?? []).length && !Object.keys(this.draft?.fields ?? {}).length;
      case "relationships": return this.view?.meta.kind !== "link" && (!this.rel || !(this.rel.incoming.length + this.rel.outgoing.length));
      case "comments": return !this.comments.length;
      case "attachments": return !this.view?.attachments?.length;
      case "documents": return !this.documents.length;
      case "overlay": return !this.overlay || (this.overlay.chain.length <= 1 && !this.overlay.overlays.length);
      case "history": case "metadata": return true; // closed unless asked for
      default: return false;
    }
  }
  private isOpen(s: Section): boolean {
    // A historic version opens what its commit changed, whatever the saved preference.
    if (this.historic && this.sectionChange(s).length) return this.versionOpen[s] ?? true;
    return this.openPrefs[s] ?? !this.isEmpty(s);
  }
  private setOpen(s: Section, open: boolean, persist = true) {
    if (this.historic && this.sectionChange(s).length) { this.versionOpen = { ...this.versionOpen, [s]: open }; return; }
    this.openPrefs = { ...this.openPrefs, [s]: open };
    if (persist) prefs.setJson(OPEN_KEY, this.openPrefs, { session: true });
    if (s === "history" && open && !this.historyLoaded) void this.loadHistory();
  }
  /** Loads the history in batches: the first one, or (more) the next older one. */
  private async loadHistory(more = false) {
    const guid = this.guid;
    const before = more ? this.history[this.history.length - 1]?.sha ?? "" : "";
    const h = await api.history(guid, before).catch((e) => { toastError(e); return null; });
    if (guid !== this.guid || !h) return;
    this.history = more ? [...this.history, ...h.history] : h.history;
    this.historyMore = h.more;
    this.historyLoaded = true;
  }
  /** Opens a section and scrolls to it. */
  private async reveal(s: Section) {
    if (!this.isOpen(s)) this.setOpen(s, true);
    await this.updateComplete;
    this.querySelector(`#sec-${s}`)?.scrollIntoView({ block: "start" });
  }
  /** A collapsible section; actions stay in the heading so they work while closed. */
  private section(s: Section, body: () => unknown, actions: unknown = nothing) {
    const open = this.isOpen(s);
    return section({ id: s, title: this.sectionName(s), count: this.sectionCount(s), open, actions, body,
      badges: this.sectionChange(s).map((t) => ({ text: t, cls: t.endsWith("removed") ? "is-removed" : t.endsWith("added") ? "is-added" : "" })),
      onToggle: (to) => this.setOpen(s, to) });
  }
  private sectionName(s: string) { return { comment: "Comment", fields: "Fields", relationships: "Relationships", comments: "Comments", attachments: "Attachments", documents: "Documents", overlay: "Overlay", history: "History", metadata: "Metadata" }[s] ?? s; }
  private sectionCount(s: string): string {
    switch (s) {
      case "fields": return String((this.schema?.fields ?? []).length || Object.keys(this.draft?.fields ?? {}).length || "");
      case "relationships": return this.view?.meta.kind === "link" ? "" : String((this.rel?.incoming.length ?? 0) + (this.rel?.outgoing.length ?? 0) || "");
      case "comments": return String(this.comments.length || "");
      case "attachments": return String(this.view?.attachments?.length || "");
      case "documents": return String(this.documents.length || "");
      case "history": return this.historyLoaded ? (this.history.length ? this.history.length + (this.historyMore ? "+" : "") : "") : "";
      case "overlay": return String(((this.overlay?.chain.length ?? 1) > 1 ? 1 : 0) + (this.overlay?.overlays.length ?? 0) || "");
      default: return "";
    }
  }

  private fieldsSection() {
    const d = this.draft!;
    const fields = this.schema?.fields ?? [];
    const known = new Set(fields.map((f) => f.id));
    const extra = Object.keys(d.fields).filter((k) => !known.has(k));
    return this.section("fields", () => html`
      ${!fields.length && !extra.length ? html`<div class="muted small">No fields defined for this type. Add a schema to describe it.</div>` : nothing}
      ${fields.map((f) => { if (f.type === "workflow") return this.workflowField(f); const ov = this.overlayState(f.id); return html`<corestone-field .field=${f} .value=${ov?.state === "inherited" ? ov.baseValue : d.fields[f.id]} .attachments=${this.view?.attachments ?? []} .files=${this.entryFiles} .typeId=${this.view?.meta.type ?? ""} .folder=${this.view?.meta.folder ?? ""}
        .overlay=${ov} .readonly=${!!this.historic} .changed=${this.changed("fields." + f.id)} @focusin=${this.touched}
        @overlay-unlock=${(e: CustomEvent) => this.setOwnField(e.detail.id, structuredClone(ov?.baseValue))}
        @overlay-revert=${(e: CustomEvent) => this.setOwnField(e.detail.id, undefined)}
        @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; this.draft = { ...d, fields: next }; this.touched(); }}
        @open-artifact=${(e: CustomEvent) => navigate({ guid: e.detail })}></corestone-field>`; })}
      ${extra.map((k) => html`<corestone-field .field=${undeclaredField(k, d.fields[k])} .value=${d.fields[k]} undeclared .files=${this.entryFiles} .readonly=${!!this.historic} .changed=${this.changed("fields." + k)}
        @field-change=${(e: CustomEvent) => { const next = { ...d.fields }; if (e.detail.value == null) delete next[e.detail.id]; else next[e.detail.id] = e.detail.value; this.draft = { ...d, fields: next }; this.touched(); }}></corestone-field>`)}`);
  }

  /** Overlay state of a field the base chain provides a value for; null when the base sets nothing. */
  private overlayState(fieldId: string): OverlayState | null {
    const base = this.baseOverlay;
    if (!base || base.fields[fieldId] === undefined) return null;
    return { from: this.levelLabel(base.origin[fieldId]), state: this.draft!.fields[fieldId] === undefined ? "inherited" : "overridden", baseValue: base.fields[fieldId] };
  }

  /** Overriding copies the base value into this entry; reverting removes the own value again. */
  private setOwnField(id: string, value: unknown) {
    const next = { ...this.draft!.fields };
    if (value === undefined) delete next[id]; else next[id] = value;
    this.draft = { ...this.draft!, fields: next };
    this.touched();
  }

  /** An overlay chain level by HID, then title, then short GUID. */
  private levelLabel(guid: string): string {
    const lvl = this.overlay?.chain.find((l) => l.guid === guid);
    return lvl?.hid || lvl?.title || guid.slice(0, 8);
  }

  /** A workflow field: its state, and the transitions allowed from it. Choosing one waits for Save. */
  private workflowField(f: Field) {
    const w = this.workflows.find((x) => x.id === f.id);
    const state = w?.state ?? (isWorkflowValue(this.draft!.fields[f.id]) ? (this.draft!.fields[f.id] as WorkflowValue).state : "");
    const next = this.pending.transitions[f.id];
    const stateName = (id: string) => { const st = w?.definition.states.find((x) => x.id === id); return st?.name || id; };
    return html`<div class="field ${this.changedClass("fields." + f.id)}" data-field=${f.id}>
      <label for=${"f-" + f.id}>${f.name || f.id}</label>
      <div class="value"><div class="workflow ${next ? "pending-add" : ""}" data-workflow=${f.id}>
        <span class="pill state ${next ? "pending-remove" : ""}">${state ? stateName(state) : "—"}</span>
        ${next ? html`<span class="arrow">→</span><span class="pill state" data-test=${"pending-state-" + f.id} title="Saved with the next Save">${stateName(next.state)}</span>` : nothing}
        ${this.historic || !w ? nothing : html`<select id=${"f-" + f.id} data-test=${"transition-" + f.id} .value=${next?.transition ?? ""} @change=${(e: Event) => this.transition(f.id, (e.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${!next}>${!w.available.length ? "No transitions available" : next ? "Keep " + stateName(w.state) : "Change state…"}</option>
          ${w.available.map((t) => html`<option value=${t.id} ?selected=${next?.transition === t.id}>${t.name || t.id} → ${stateName(t.to)}</option>`)}
        </select>`}
        ${w ? html`<button class="btn sm" title=${"Workflow " + (w.definition.name || w.definition.id)} @click=${() => (this.showDiagram = this.showDiagram === f.id ? null : f.id)}>? diagram</button>` : nothing}
        ${w && this.showDiagram === f.id ? html`<div class="wf-diagram" style="flex-basis:100%">
          ${w.definition.states.map((s) => html`<span class="wf-state ${s.id === w.state ? "current" : ""}" style=${s.presentation?.color ? `border-color:${s.presentation.color}` : ""}>${s.name || s.id}</span>`)}
          <span class="wf-edge">·</span>
          ${w.definition.transitions.map((t) => html`<span class="wf-edge">${t.from.join("|")} → ${t.to} (${t.name || t.id})</span>`)}
          <span class="muted small">defined in ${w.definition.scope || "/"}</span></div>` : nothing}
      </div>
      ${f.description ? html`<div class="help">${f.description}</div>` : nothing}</div>
    </div>`;
  }

  /**
   * Where a reference to another artifact leads: in a historic version to that artifact as it was
   * at the same commit (documents have no version view), otherwise to it as it is now.
   */
  private refRoute(guid: string, s?: Summary | null): Partial<Route> {
    const h = this.historic;
    return h && s?.etag && s.kind !== "document" ? { guid, version: s.etag, at: h.commit.sha } : { guid };
  }

  private refHref(r: Partial<Route>) {
    return "/artifact/" + r.guid + (r.version ? `?version=${r.version}&at=${r.at}` : "");
  }

  /** An artifact reference: type icon, HID and title, opening it; a missing one shows its GUID. */
  private artifactRef(guid: string | undefined, s: Summary | null | undefined) {
    if (!guid) return html`<span class="muted">—</span>`;
    if (!s) return html`<span class="muted mono" title=${this.historic ? "This artifact did not exist then" : "This artifact no longer exists"}>${guid}</span>`;
    const to = this.refRoute(guid, s);
    return html`<span class="endpoint"><corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span>` : nothing}
        <a href=${this.refHref(to)} @click=${(e: Event) => { e.preventDefault(); navigate({ ...to, tab: "" }); }}>${label(s)}</a></span>`;
  }

  /** An artifact cell opening it; the row click does the same. */
  private openCell(s: Summary, tab?: string) {
    const to = this.refRoute(s.guid, s);
    return html`<corestone-type-icon .kind=${s.kind} .type=${s.type} .folder=${s.folder}></corestone-type-icon>${s.hid ? html`<span class="hid">${s.hid}</span> ` : nothing}<a href=${this.refHref(to)} @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); navigate(tab === undefined ? to : { ...to, tab }); }}>${label(s)}</a>`;
  }

  /** A link's own relation: From → role → To, each endpoint opening that artifact. */
  private linkRelSection() {
    const v = this.view!;
    return this.section("relationships", () => html`<div class="links-list"><div class="link-row" data-test="link-relation">
      <span class=${this.changedClass("source")}>${this.artifactRef(v.meta.source, this.endpoints?.source)}</span>
      <span class="arrow">→</span><span class="type">${this.schema?.displayName ?? v.meta.type}</span><span class="arrow">→</span>
      <span class=${this.changedClass("target")}>${this.artifactRef(v.meta.target, this.endpoints?.target)}</span></div></div>`);
  }

  /** A comment itself: what it is on (and whom it answers), then its author, time and text. */
  private ownCommentSection() {
    const v = this.view!;
    const sub = this.subject;
    const parent = String(v.data.parent ?? "");
    const answered = parent ? this.comments.find((c) => c.meta.guid === parent) : undefined;
    const on = !sub ? this.artifactRef(v.meta.subject, null)
      : sub.meta.kind !== "link" ? this.artifactRef(sub.meta.guid, sub.meta)
      : html`${this.artifactRef(sub.meta.source, sub.source)}
        <a class="muted" href=${this.refHref(this.refRoute(sub.meta.guid, sub.meta))} @click=${(e: Event) => { e.preventDefault(); navigate({ ...this.refRoute(sub.meta.guid, sub.meta), tab: "" }); }}>→ ${sub.role ?? sub.meta.type} →</a>
        ${this.artifactRef(sub.meta.target, sub.target)}`;
    return this.section("comment", () => html`
      <div class="comment-on" data-test="comment-subject">
        <corestone-type-icon .kind=${v.meta.kind} .type=${v.meta.type} .folder=${v.meta.folder} .schema=${this.schema}></corestone-type-icon>
        <span class="muted">on</span><div class="link-row">${on}</div></div>
      ${parent ? html`<div class="small muted" data-test="comment-parent" style="margin-top:6px">Reply to
        <a href=${this.refHref(this.refRoute(parent, answered?.meta))} @click=${(e: Event) => { e.preventDefault(); navigate({ ...this.refRoute(parent, answered?.meta), tab: "" }); }}>${answered ? `${answered.meta.author || "anonymous"}'s comment` : "a comment"}</a></div>` : nothing}
      <div class="comment ${this.changedClass("text")}" data-test="comment-own">
        <div class="who"><b>${v.meta.author || "anonymous"}</b> · ${fmtTime(v.meta.created)}</div>
        <div class="text">${String(v.data.text ?? "")}</div>
      </div>`);
  }

  private relSection() {
    if (this.view?.meta.kind === "link") return this.linkRelSection();
    const rel = this.rel;
    type Row = { link: Summary; other: Summary; role?: string; dir: "in" | "out"; pending?: number };
    const p = this.pending;
    const rows: Row[] = [...(rel ? [...rel.outgoing.map((l) => ({ ...l, dir: "out" as const })), ...rel.incoming.map((l) => ({ ...l, dir: "in" as const }))] : []),
      ...p.links.map((l, i) => ({ link: { guid: "pending-" + i, kind: "link" as const, type: l.type, folder: "", path: "", source: l.source, target: l.target, links: 0, comments: 0 }, other: l.other, role: l.role, dir: l.dir, pending: i }))];
    const removeLink = (r: Row) => r.pending !== undefined
      ? (this.pending = { ...p, links: p.links.filter((_, i) => i !== r.pending) })
      : this.toggleLinkRemoval(r.link.guid);
    const removing = (r: Row) => p.removedLinks.includes(r.link.guid);
    const columns: TableColumn<Row>[] = [
      { id: "role", name: "Role", width: 160, value: (r) => r.role || r.link.type, render: (r) => html`<span class="type" title=${r.link.type}>${r.role || r.link.type}</span>` },
      { id: "dir", name: "Dir", width: 72, value: (r) => r.dir, render: (r) => html`<span class="arrow ${r.dir}" title=${r.dir === "in" ? "incoming: the other artifact links to this one" : "outgoing: this artifact links to the other"}>${r.dir === "in" ? "←" : "→"}</span>` },
      { id: "artifact", name: "Artifact", value: (r) => r.other.hid || label(r.other), render: (r) => this.openCell(r.other) },
      { id: "folder", name: "Folder", width: 150, value: (r) => r.other.folder, render: (r) => html`<span class="muted small">${r.other.folder || "/"}</span>` },
      ...(this.historic ? [] : [{ id: "remove", name: "", width: 60, sortable: false, render: (r: Row) => removing(r)
        ? html`<button class="btn sm" title="Keep link" aria-label="Keep link" data-test="link-keep" @click=${(e: Event) => { e.stopPropagation(); removeLink(r); }}>↺</button>`
        : html`<button class="btn sm" title="Remove link" aria-label="Remove link" @click=${(e: Event) => { e.stopPropagation(); removeLink(r); }}>✕</button>` }]),
    ];
    const actions = this.historic ? nothing : html`
        ${rel?.allowedAsSource.map((s) => html`<button class="btn sm" @click=${() => this.addLink(true, s.type, s.displayName || s.type, s.targetTypes)}>＋ ${s.displayName || s.type} →</button>`)}
        ${rel?.allowedAsTarget.filter((s) => !rel.allowedAsSource.some((x) => x.type === s.type)).map((s) => html`<button class="btn sm" @click=${() => this.addLink(false, s.type, s.reverseName || s.displayName || s.type, s.sourceTypes)}>＋ ${s.reverseName || s.displayName || s.type} ←</button>`)}
        ${rel && !rel.allowedAsSource.length && !rel.allowedAsTarget.length ? html`<span class="muted small" data-test="no-link-types">No link type here allows ${this.view?.meta.type ?? "this type"} as an endpoint.</span>` : nothing}`;
    return this.section("relationships", () => html`
      ${!rows.length ? html`<div class="muted small">No links yet.</div>` : html`<corestone-table class="detail-table" .items=${rows} .columns=${columns}
        .rowKey=${(r: Row) => r.link.guid} .rowClass=${(r: Row) => `link-row open-row ${this.added(r.link.guid) ? "added" : ""} ${r.pending !== undefined ? "pending-add" : ""} ${removing(r) ? "pending-remove" : ""}`} @row-click=${(e: CustomEvent<Row>) => navigate(this.refRoute(e.detail.other.guid, e.detail.other))}></corestone-table>`}
      `, actions);
  }

  private commentSection() {
    const byParent = new Map<string, CommentView[]>();
    // Pending comments sit in their thread like stored ones, marked until saved.
    const pending: CommentView[] = this.pending.comments.map((c, i) => ({
      meta: { guid: "pending-" + i, kind: "comment", type: c.type ?? "comment", folder: "", path: "", author: this.s.user, links: 0, comments: 0 },
      data: { type: c.type, text: c.text, parent: c.parent } }));
    const all = [...this.comments, ...pending];
    const known = new Set(all.map((c) => c.meta.guid));
    for (const c of all) {
      let p = String(c.data?.parent ?? "");
      if (p && (!known.has(p) || p === c.meta.guid)) p = ""; // orphaned reply: show at the root
      byParent.set(p, [...(byParent.get(p) ?? []), c]);
    }
    const seen = new Set<string>();
    const render = (parent: string, depth: number): TemplateResult[] => (byParent.get(parent) ?? []).filter((c) => !seen.has(c.meta.guid) && seen.add(c.meta.guid) && depth < 50).map((c) => { const pi = c.meta.guid.startsWith("pending-") ? Number(c.meta.guid.slice(8)) : -1; return html`<div class="comment ${depth ? "reply" : ""} ${c.meta.guid === this.guid ? "current" : ""} ${this.added(c.meta.guid) ? "added" : ""} ${pi >= 0 ? "pending-add" : ""}" data-comment=${c.meta.guid}>
      <div class="who"><b>${c.meta.author || "anonymous"}</b> · ${pi >= 0 ? html`<i>unsaved</i>` : fmtTime(c.meta.created)} ${c.data?.type && c.data.type !== "comment" ? html`<span class="pill">${String(c.data.type)}</span>` : nothing}
        ${pi >= 0 ? html`<a href="#" data-test="comment-drop" @click=${(e: Event) => { e.preventDefault(); this.pending = { ...this.pending, comments: this.pending.comments.filter((_, i) => i !== pi) }; }}>remove</a>`
        : this.commentType ? html`<a href="#" @click=${(e: Event) => { e.preventDefault(); this.replyTo = c.meta.guid; this.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>reply</a>` : nothing}</div>
      <div class="text">${String(c.data?.text ?? "")}</div>
      ${render(c.meta.guid, depth + 1)}</div>`; });
    const actions = this.historic ? nothing : !this.commentType
      ? html`<span class="muted small" data-test="no-comment-type">No comment type is defined here, so no comments can be added.</span>`
      : html`<button class="btn sm" data-test="comment-add" @click=${async () => { await this.reveal("comments"); this.querySelector<HTMLTextAreaElement>("#comment-text")?.focus(); }}>＋ Comment</button>`;
    return this.section("comments", () => html`
      ${!all.length ? html`<div class="muted small">No comments yet.</div>` : render("", 0)}
      ${!this.commentType ? nothing : html`<div class="inline-form">
        <textarea id="comment-text" data-test="comment-text" placeholder=${this.replyTo || this.view?.meta.kind === "comment" ? "Reply…" : "Write a comment…"} .value=${this.commentText} @input=${(e: Event) => (this.commentText = (e.target as HTMLTextAreaElement).value)}></textarea>
        <div style="display:flex;flex-direction:column;gap:4px">
          <button class="btn primary sm" data-test="comment-send" title=${this.dirty ? "Saved together with your other changes" : "Publishes the comment now"} @click=${this.addComment}>${this.dirty ? "Add" : "Post"}</button>
          ${this.replyTo ? html`<button class="btn sm" @click=${() => (this.replyTo = null)}>cancel reply</button>` : nothing}
        </div></div>`}`, actions);
  }

  private attachmentSection() {
    const h = this.historic;
    const p = this.pending;
    type Row = Attachment & { file?: File };
    const staged = new Set(p.files.map((f) => f.name));
    const att: Row[] = [...(this.view?.attachments ?? []).filter((a) => h || !staged.has(a.name)),
      ...(h ? [] : p.files.map((f) => ({ name: f.name, path: "", etag: "", size: f.size, file: f })))];
    const url = (a: Attachment) => h ? api.versionFileUrl(this.guid, h.etag, h.commit.sha, a.name) : api.fileUrl(this.guid, a.name);
    const removing = (a: Row) => !a.file && p.removedFiles.includes(a.name);
    const remove = (a: Row) => a.file
      ? (this.pending = { ...p, files: p.files.filter((f) => f !== a.file) })
      : this.toggleFileRemoval(a.name);
    return this.section("attachments", () => html`
      ${!att.length ? html`<div class="muted small">Files stored in the artifact's GUID directory appear here.</div>` : nothing}
      ${!att.length ? nothing : html`<corestone-table class="detail-table" .items=${att} .rowKey=${(a: Row) => (a.file ? "pending:" : "") + a.name}
        .rowClass=${(a: Row) => `attach-row ${a.file ? "pending-add" : ""} ${removing(a) ? "pending-remove" : ""}`} .columns=${[
        { id: "name", name: "Name", value: (a) => a.name, render: (a) => a.file ? html`<span title="Stored with the next Save">${a.name}</span>` : html`<a href=${url(a)} target="_blank" rel="noopener">${a.name}</a>` },
        { id: "size", name: "Size", width: 100, value: (a) => a.size, render: (a) => html`<span class="size">${fmtSize(a.size)}</span>` },
        ...(h ? [] : [{ id: "remove", name: "", width: 60, sortable: false, render: (a: Row) => removing(a)
          ? html`<button class="btn sm" title="Keep attachment" aria-label="Keep attachment" @click=${() => remove(a)}>↺</button>`
          : html`<button class="btn sm" title="Remove attachment" aria-label="Remove attachment" @click=${() => remove(a)}>✕</button>` }]),
      ] satisfies TableColumn<Row>[]}></corestone-table>`}`,
      h ? nothing : html`<label class="btn sm">＋ Upload<input type="file" multiple hidden @change=${this.upload} /></label>`);
  }

  /** The documents embedding this entry; each opens scrolled to the entry's block. */
  private documentSection() {
    return this.section("documents", () => !this.documents.length
      ? html`<div class="muted small">This entry is not used in any document.</div>`
      : html`<corestone-table class="detail-table" data-test="documents" .items=${this.documents} .rowClass=${() => "open-row"} .columns=${[
        { id: "document", name: "Document", value: (d) => d.hid || label(d), render: (d) => this.openCell(d, "entry:" + this.guid) },
        { id: "type", name: "Type", width: 140, value: (d) => d.type, render: (d) => html`<span class="muted small">${d.type}</span>` },
        { id: "folder", name: "Folder", width: 150, value: (d) => d.folder, render: (d) => html`<span class="muted small">${d.folder || "/"}</span>` },
      ] satisfies TableColumn<Summary>[]} @row-click=${(e: CustomEvent<Summary>) => navigate({ guid: e.detail.guid, tab: "entry:" + this.guid })}></corestone-table>`);
  }

  /** This entry with its direct neighbours: the base it overrides and the overlays overriding it. */
  private overlaySection() {
    const ov = this.overlay!;
    const self = ov.chain[ov.chain.length - 1];
    const base = ov.chain.length > 1 ? ov.chain[ov.chain.length - 2] : null;
    const sets = (fields: string[]) => html`<small>${fields.length ? "sets " + fields.join(", ") : "sets nothing"}</small>`;
    const node = (guid: string, hid: string | undefined, title: string | undefined, fields: string[]) => html`<div class="node" data-guid=${guid}>
      <a href=${"/artifact/" + guid} @click=${(e: Event) => { e.preventDefault(); navigate({ guid }); }}>${hid ? html`<span class="hid">${hid}</span> ` : nothing}${title || (hid ? "" : guid.slice(0, 8))}</a>
      ${sets(fields)}</div>`;
    const empty = !base && !ov.overlays.length;
    return this.section("overlay", () => html`${this.baseChangePreview()}${this.underlayForm()}${empty ? html`<div class="muted small">This entry is no overlay and has no overlays.</div>` : html`
      <div class="chain">
        ${base ? html`<div class="col">${node(base.guid, base.hid, base.title, base.fields)}</div><span class="arrow" title=${OVERLAY_HELP}>→ overlaid by</span>` : nothing}
        <div class="col"><div class="node self"><b>this entry</b>${sets(self?.fields ?? [])}</div></div>
        ${ov.overlays.length ? html`<span class="arrow" title=${OVERLAY_HELP}>→ overlaid by</span>
          <div class="col" data-test="overlays">${ov.overlays.map((o) => node(o.guid, o.hid, o.title, Object.keys(o.fields ?? {}).filter((id) => !isWorkflowValue(o.fields![id]))))}</div>` : nothing}
      </div>
      ${base ? html`<dl class="kv" style="margin-top:10px"><dt>Effective fields</dt><dd>${Object.entries(ov.fields).map(([k, v]) => html`<div><b>${k}</b>: ${showValue(v)} <span class="muted small">from ${ov.origin[k] === this.guid ? "this entry" : this.levelLabel(ov.origin[k])}</span></div>`)}</dd></dl>` : nothing}`}`,
      this.historic ? nothing : html`${this.baseActions(!!base)}<button class="btn sm" data-test="create-overlay" @click=${this.createOverlay}>＋ Create overlay</button>`);
  }

  /** One button for the base: the picker chooses a new one or, if there is one, removes it. */
  private baseActions(hasBase: boolean) {
    const blocked = this.dirty;
    return html`<button class="btn sm" data-test="change-base" ?disabled=${blocked}
      title=${blocked ? "Save or discard your changes first" : hasBase ? "Choose another base or remove it" : "Inherit the fields this entry does not set from another entry"}
      @click=${this.pickBase}>${hasBase ? "Change base…" : "Inherit from…"}</button>`;
  }

  /** Picks a new base of the same type, or removes the current one; nothing changes until the preview is applied. */
  private pickBase = () => {
    const v = this.view!;
    const base = v.meta.base;
    const actions: PickerAction[] = [{ label: "Create new base…", test: "create-base", tone: "add", run: this.startUnderlay }];
    if (base) actions.push({ label: `Remove base ${this.levelLabel(base)}`, test: "remove-base", tone: "remove", run: () => { void this.previewBase(null); } });
    store.set({ picker: { kind: "pick", title: base ? "Change or remove the base" : "Choose or create a base", types: [v.meta.type], kinds: ["entry"], exclude: this.guid,
      actions, onPick: (s: Summary) => { void this.previewBase(s); } } });
  };

  /** The fields this entry sets itself, which can move into a new base. A workflow's state cannot: every entry has its own. */
  private ownFields(): Record<string, unknown> {
    const own = ((this.view?.data as Record<string, unknown> | undefined)?.fields ?? {}) as Record<string, unknown>;
    const workflows = new Set((this.schema?.fields ?? []).filter((f) => f.type === "workflow").map((f) => f.id));
    return Object.fromEntries(Object.entries(own).filter(([id]) => !workflows.has(id)));
  }

  /** Without a base of its own, a new base must contain the required fields. */
  private mustMove(id: string): boolean {
    return !this.view?.meta.base && !!this.schema?.fields?.find((f) => f.id === id)?.required;
  }

  private startUnderlay = () => {
    this.baseChange = null;
    this.underlay = { title: this.view?.meta.title ?? "", fields: new Set(Object.keys(this.ownFields())) };
    void this.reveal("overlay");
  };

  private toggleUnderlayField(id: string, on: boolean) {
    const fields = new Set(this.underlay!.fields);
    if (on) fields.add(id); else fields.delete(id);
    this.underlay = { ...this.underlay!, fields };
  }

  /** The new base: title, the fields that move, and the resulting chain. Effective values stay. */
  private underlayForm() {
    const u = this.underlay;
    if (!u || !this.view) return nothing;
    const own = this.ownFields();
    const ids = Object.keys(own);
    const base = this.view.meta.base;
    const name = (id: string) => this.schema?.fields?.find((f) => f.id === id)?.name || id;
    const show = (v: unknown) => html`<span class="pre-line">${showValue(v)}</span>`;
    return html`<div class="base-change" data-test="underlay">
      <div class="title">Create a new base for this entry</div>
      <label class="underlay-title small">Title of the new base
        <input type="text" data-test="underlay-title" .value=${u.title} @input=${(e: Event) => { this.underlay = { ...u, title: (e.target as HTMLInputElement).value }; }}></label>
      ${ids.length ? html`<div class="small">Fields that move into the new base:</div>
        <div class="underlay-fields">${ids.map((id) => html`<label class="small" data-field=${id}>
          <input type="checkbox" .checked=${u.fields.has(id) || this.mustMove(id)} ?disabled=${this.mustMove(id)}
            @change=${(e: Event) => this.toggleUnderlayField(id, (e.target as HTMLInputElement).checked)}>
          <span><b>${name(id)}</b>: ${show(own[id])}${this.mustMove(id) ? html` <span class="muted">(required: a base without a base of its own must set it)</span>` : nothing}</span></label>`)}</div>`
        : html`<div class="muted small">This entry sets no fields itself; the new base starts empty.</div>`}
      <div class="chain small" data-test="underlay-chain">${base ? html`<span>${this.levelLabel(base)}</span><span class="arrow">→ overlaid by</span>` : nothing}
        <span><b>new base</b></span><span class="arrow">→ overlaid by</span><span>this entry</span></div>
      <div class="muted small">The moved values are inherited from the new base, so this entry's effective values stay the same.${base ? ` The new base inherits from ${this.levelLabel(base)}.` : ""}</div>
      <div class="buttons">
        <button class="btn sm" data-test="cancel-underlay" @click=${() => { this.underlay = null; }}>Cancel</button>
        <button class="btn sm primary" data-test="apply-underlay" ?disabled=${this.busy} @click=${this.applyUnderlay}>Create base</button>
      </div></div>`;
  }

  /** One commit: the new base with the moved fields, and this entry inheriting them. */
  private applyUnderlay = async () => {
    const u = this.underlay, v = this.view;
    if (!u || !v) return;
    const fields = Object.keys(this.ownFields()).filter((id) => u.fields.has(id) || this.mustMove(id));
    this.busy = true;
    try {
      const res = await api.underlay(this.guid, u.title.trim(), fields, v.etag);
      store.toast(`New base ${label(res.base.meta)} created`, "success");
      this.underlay = null;
      this.reload(true);
      store.refresh();
    } catch (e) { toastError(e); }
    finally { this.busy = false; }
  };

  private async previewBase(to: Summary | null) {
    try {
      const next = to ? await api.overlay(to.guid) : null;
      this.underlay = null;
      this.baseChange = { to, next, keep: true };
      void this.reveal("overlay");
    } catch (e) { toastError(e); }
  }

  /** Effective values before and after the base change. Values set in this entry stay; on
   *  removal with "keep", inherited values are copied into the entry. */
  private baseChangeRows() {
    const c = this.baseChange!, ov = this.overlay!;
    const own = this.ownFields();
    const after: Record<string, unknown> = {}, afterFrom: Record<string, string> = {};
    if (c.next) for (const [k, v] of Object.entries(c.next.fields)) { after[k] = v; afterFrom[k] = c.next.origin[k]; }
    if (!c.to && c.keep) for (const [k, v] of Object.entries(ov.fields)) { after[k] = v; afterFrom[k] = this.guid; }
    for (const [k, v] of Object.entries(own)) { after[k] = v; afterFrom[k] = this.guid; }
    const levels = [...ov.chain, ...(c.next?.chain ?? [])];
    const from = (g: string | undefined) => !g ? "" : g === this.guid ? "this entry" : ((l) => l?.hid || l?.title || g.slice(0, 8))(levels.find((l) => l.guid === g));
    const name = (id: string) => this.schema?.fields?.find((f) => f.id === id)?.name || id;
    const ids = [...new Set([...Object.keys(ov.fields), ...Object.keys(after)])];
    return ids.map((id) => ({ id, name: name(id), before: ov.fields[id], beforeFrom: from(ov.origin[id]), after: after[id], afterFrom: from(afterFrom[id]),
      changed: !deepEqual(ov.fields[id], after[id]) }));
  }

  private baseChangePreview() {
    const c = this.baseChange;
    if (!c || !this.view || !this.overlay) return nothing;
    const cycle = !!c.next?.chain.some((l) => l.guid === this.guid);
    const same = !!c.to && c.to.guid === this.view.meta.base;
    const rows = cycle || same ? [] : this.baseChangeRows();
    const changed = rows.filter((r) => r.changed);
    const ownCount = Object.keys(this.ownFields()).length;
    const overlays = this.overlay.overlays.length;
    const show = (v: unknown) => v === undefined || v === "" ? html`<span class="muted">—</span>` : html`<span class="pre-line">${showValue(v)}</span>`;
    return html`<div class="base-change" data-test="base-change">
      <div class="title">${c.to ? html`Change the base to <b>${label(c.to)}</b>` : html`Remove the base <b>${this.levelLabel(this.view.meta.base ?? "")}</b>`}</div>
      ${cycle ? html`<div class="notice error">${label(c.to)} inherits from this entry, so it cannot become its base (cycle).</div>`
        : same ? html`<div class="muted small">This already is the base; nothing changes.</div>` : html`
        ${!c.to ? html`<label class="keep small"><input type="checkbox" data-test="keep-values" .checked=${c.keep}
          @change=${(e: Event) => { this.baseChange = { ...c, keep: (e.target as HTMLInputElement).checked }; }}> Keep the inherited values in this entry</label>` : nothing}
        ${changed.length ? html`<div class="resizable-area"><div class="base-diff-wrap" data-test="base-diff-wrap" style=${savedHeight("baseDiff") ? savedHeight("baseDiff") + ";max-height:none" : ""}>
          <table class="base-diff" data-test="base-diff"><thead><tr><th>Field</th><th>Now</th><th>After the change</th></tr></thead>
          <tbody>${changed.map((r) => html`<tr data-field=${r.id}><td>${r.name}</td>
            <td>${show(r.before)} ${r.beforeFrom ? html`<small class="muted">from ${r.beforeFrom}</small>` : nothing}</td>
            <td>${show(r.after)} ${r.afterFrom ? html`<small class="muted">from ${r.afterFrom}</small>` : nothing}</td></tr>`)}</tbody></table></div>${heightGrip("baseDiff")}</div>`
          : html`<div class="muted small" data-test="base-no-change">No effective value changes.</div>`}
        <div class="muted small">${ownCount === 1 ? "1 value set in this entry stays" : `${ownCount} values set in this entry stay`} as ${ownCount === 1 ? "it is" : "they are"}.${
          overlays ? ` ${overlays === 1 ? "Its overlay inherits" : `Its ${overlays} overlays inherit`} the new values too.` : ""}</div>`}
      <div class="buttons">
        <button class="btn sm" data-test="cancel-base" @click=${() => { this.baseChange = null; }}>Cancel</button>
        <button class="btn sm primary" data-test="apply-base" ?disabled=${cycle || same || this.busy} @click=${this.applyBase}>${c.to ? "Change base" : "Remove base"}</button>
      </div></div>`;
  }

  /** One update: the new base, plus on removal with "keep" the inherited values. */
  private applyBase = async () => {
    const c = this.baseChange, v = this.view, ov = this.overlay;
    if (!c || !v || !ov) return;
    const patch: Record<string, unknown> = { base: c.to?.guid ?? "" };
    if (!c.to && c.keep) {
      const copy = Object.fromEntries(Object.entries(ov.fields).filter(([k]) => ov.origin[k] !== this.guid));
      if (Object.keys(copy).length) patch.fields = copy;
    }
    this.busy = true;
    try {
      await api.update(this.guid, patch, v.etag);
      store.toast(c.to ? `Base changed to ${label(c.to)}` : "Base removed", "success");
      this.baseChange = null;
      this.reload(true);
      store.refresh();
    } catch (e) { toastError(e); }
    finally { this.busy = false; }
  };

  /** The commits that touched the artifact, newest first; each opens the artifact as it was then. */
  private historySection() {
    // Documents open in the document view, which shows no versions yet.
    const linkable = (h: HistoryEntry) => !!h.blob && this.view?.meta.kind !== "document";
    const shown = (h: HistoryEntry) => !!this.historic && h.sha === this.historic.commit.sha;
    const open = (h: HistoryEntry) => { if (linkable(h)) navigate({ version: h.blob!, at: h.sha }); };
    return this.section("history", () => !this.historyLoaded ? html`<div class="muted small">Loading…</div>` : html`
      ${!this.history.length ? nothing : html`<corestone-table class="detail-table" data-test="history" .items=${this.history} .rowKey=${(h: HistoryEntry) => h.sha}
        .rowClass=${(h: HistoryEntry) => `history-row ${linkable(h) ? "open-row" : ""} ${shown(h) ? "shown" : ""}`} .columns=${[
        { id: "when", name: "When", width: 150, value: (h) => h.time, render: (h) => html`<span class="when" title=${h.time}>${fmtTime(h.time)}</span>` },
        { id: "change", name: "Change", value: (h) => h.subject, render: (h) => html`${linkable(h)
          ? html`<a href=${`/artifact/${this.guid}?version=${h.blob}&at=${h.sha}`} data-test="history-version" title="Show the artifact as it was after this change"
              @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); open(h); }}>${h.subject}</a>`
          : h.subject}${h.trailers?.["Corestone-Op"] ? html` <span class="pill">${h.trailers["Corestone-Op"]}</span>` : nothing}
          ${(h.recreates ?? []).map((r) => html`<div class="muted small" data-test="history-recreates">Same link as one deleted
            ${r.deletedAt ? fmtTime(r.deletedAt) : ""}${r.deletedBy ? ` by ${r.deletedBy}` : ""}${r.blob ? html` · <a href=${`/artifact/${r.prior}?version=${r.blob}${r.at ? `&at=${r.at}` : ""}`}
              data-test="history-recreates-prior" @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); navigate({ guid: r.prior, version: r.blob!, at: r.at ?? "" }); }}>show it</a>` : nothing}</div>`)}` },
        { id: "author", name: "Author", width: 130, value: (h) => h.author, render: (h) => html`<span class="muted small">${h.author}</span>` },
        { id: "commit", name: "Commit", width: 100, value: (h) => h.sha, render: (h) => html`<span class="mono muted">${h.sha.slice(0, 8)}</span>` },
      ] satisfies TableColumn<HistoryEntry>[]} @row-click=${(e: CustomEvent<HistoryEntry>) => open(e.detail)}></corestone-table>`}
      ${!this.history.length ? html`<div class="muted small">No history yet.</div>` : nothing}
      ${this.historyMore ? html`<button class="btn sm" data-test="history-more" style="margin-top:6px" @click=${() => this.loadHistory(true)}>Load older changes</button>` : nothing}`);
  }

  /** Every read-only property not shown elsewhere, plus extra stored properties. */
  private metadataSection() {
    const v = this.view!;
    const d = { ...(v.data as Record<string, unknown>) };
    for (const k of ["guid", "kind", "type", "title", "hid", "fields", "workflows", "content"]) delete d[k];
    return this.section("metadata", () => html`
      <dl class="kv">
        <dt>Type</dt><dd>${this.schema?.displayName ?? v.meta.type} <span class="muted">(${v.meta.type}${this.schema ? "" : ", no schema"})</span></dd>
        <dt>Kind</dt><dd>${v.meta.kind}</dd>
        <dt>Folder</dt><dd><a href=${"/folder/" + v.meta.folder} @click=${(e: Event) => { e.preventDefault(); navigate({ folder: v.meta.folder, guid: null }); }}>${v.meta.folder || "/"}</a></dd>
        <dt>GUID</dt><dd class="mono">${v.meta.guid}</dd>
        <dt>ETag</dt><dd class="mono">${v.etag.slice(0, 12)}</dd>
        <dt>Created</dt><dd>${fmtTime(v.meta.createdAt)}</dd>
        <dt>Modified</dt><dd>${fmtTime(v.meta.modifiedAt)}</dd>
        ${this.schema?.sources?.length ? html`<dt>Schema from</dt><dd>${this.schema.sources.map((s) => s || "/").join(" → ")}</dd>` : nothing}
        <dt>Path</dt><dd class="mono">${v.meta.path}</dd>
      </dl>
      <h4 class="small muted" style="margin-top:10px">Additional properties</h4>
      ${Object.keys(d).length ? html`<pre class="json">${JSON.stringify(d, null, 2)}</pre>` : html`<div class="muted small">No extra properties. Tools may add their own; they are preserved on save.</div>`}`);
  }
}
