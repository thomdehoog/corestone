import type {
  Attachment, CommentView, HistoryEntry, Issue, OverlayView, Relationships, QueryWarning, RepoStatus, Schema, SortLevel, Summary, TableFilter, TableRows, Tree, VersionView, View,
  Workflow, WorkflowEval,
} from "./types";
import { prefs } from "@corestone/ui";

export class ApiError extends Error {
  /** body is the parsed error response, e.g. the conflicts of a refused save. */
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

/** A local account (-auth local). */
export interface Account { guid: string; name: string; email: string; role: "user" | "admin"; created: string }
/** How the server signs in: "none" is open; "local" needs an account, and "setup" means none exists yet. */
export interface AuthState { mode: "local" | "none"; setup?: boolean; account?: Account | null; diagrams?: string }

/** What the server offers besides its API (from GET /api/auth at start). */
export const server = {
  /** Where the draw.io web app is, for diagrams in rich text ("" when diagrams are off). */
  diagrams: "",
};

let onUnauthorized: (() => void) | null = null;
/** Called when the session has ended (any 401 outside signing in). */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

/** Names the configured user so the server records them as commit author. */
function userHeader(): Record<string, string> {
  const user = prefs.text("corestone.user") || "";
  return user ? { "X-Corestone-User": encodeURIComponent(user) } : {};
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, headers: { ...userHeader(), ...headers }, signal };
  if (body !== undefined) {
    if (typeof body === "string" || body instanceof FormData) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    }
  }
  // Maintenance mode (reindex, large restructuring) answers 503 with
  // Retry-After before anything was written; keep retrying for up to a
  // minute instead of failing the user's action. The header shows the
  // rebuild's progress meanwhile.
  let res = await fetch("/api" + path, init);
  const deadline = Date.now() + 60_000;
  for (let delay = 500; res.status === 503 && res.headers.get("Retry-After") && Date.now() < deadline; delay = Math.min(delay * 1.5, 2000)) {
    await new Promise((r) => setTimeout(r, delay));
    res = await fetch("/api" + path, init);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  if (res.status === 401 && !path.startsWith("/auth")) onUnauthorized?.();
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? res.statusText;
    throw new ApiError(res.status, msg, parsed);
  }
  return parsed as T;
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    sp.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  const s = sp.toString();
  return s ? "?" + s : "";
};

/** The body of a save: what changed besides attachments to store. */
export interface SaveChanges {
  patch?: Record<string, unknown>;
  /** Transitions to run, each on a workflow field, by the transition's id. */
  transitions?: { field: string; transition: string }[];
  addLinks?: { type: string; source: string; target: string }[];
  /** Each removed link with the version the user saw: a link changed since conflicts. */
  removeLinks?: { guid: string; etag?: string }[];
  addComments?: { type: string | null; text: string; parent?: string; author: string }[];
  removeFiles?: string[];
  /** A document's new entries, created with its save; key: the name its content uses for one. */
  addEntries?: { key: string; path: string; type: string; title: string; fields: Record<string, unknown> }[];
  /** The ETag of a conflict the user chose to overwrite. */
  overwrite?: string;
}

/** One thing both the user and someone else changed (a refused save, 412). */
export interface SaveConflictItem { key: string; author?: string; time?: string; base?: unknown; theirs?: unknown; mine?: unknown }
export interface SaveConflict { etag: string; conflicts: SaveConflictItem[] }

export const api = {
  auth: () => request<AuthState>("GET", "/auth"),
  setup: (name: string, email: string, password: string) => request<Account>("POST", "/auth/setup", { name, email, password }),
  login: (email: string, password: string) => request<Account>("POST", "/auth/login", { email, password }),
  logout: () => request<void>("POST", "/auth/logout"),
  updateMe: (name: string, email: string) => request<Account>("PATCH", "/me", { name, email }),
  changePassword: (current: string, password: string) => request<Account>("POST", "/me/password", { current, password }),
  accounts: () => request<{ accounts: Account[]; unknownAdmins: string[] }>("GET", "/accounts"),
  deleteAccount: (guid: string) => request<void>("DELETE", `/accounts/${guid}`),
  setRole: (guid: string, role: "user" | "admin") => request<Account>("PUT", `/accounts/${guid}/role`, { role }),
  createAccount: (a: { name: string; email: string; password: string; role: "user" | "admin" }) => request<Account>("POST", "/accounts", a),
  resetPassword: (guid: string, password: string) => request<void>("POST", `/accounts/${guid}/password`, { password }),
  status: () => request<RepoStatus>("GET", "/repository"),
  tree: (path: string, subtree: boolean, limit = 500) => request<Tree>("GET", "/repository/tree" + q({ path, subtree, limit })),
  search: (params: { q?: string; kind?: string; type?: string; path?: string; subtree?: boolean; limit?: number; [k: string]: string | number | boolean | undefined }) =>
    request<{ artifacts: Summary[]; total: number }>("GET", "/repository/search" + q(params)),
  types: (path: string) => request<{ types: Schema[] }>("GET", "/repository/types" + q({ path })),
  /** The options of a dynamic enumeration field: the artifacts its source names. */
  options: (type: string, field: string, path = "") => request<{ options: Summary[] }>("GET", "/repository/options" + q({ type, field, path })),
  values: (type: string, field: string, path = "") => request<{ values: { value: string; count: number }[] }>("GET", "/repository/values" + q({ type, field, path })),
  validate: () => request<{ issues: Issue[]; errors: number; warnings: number }>("GET", "/repository/validate"),
  reindex: () => request<{ started: boolean }>("POST", "/repository/reindex"),
  moveFolder: (from: string, to: string) => request<{ moved: number }>("POST", "/repository/folders/move", { from, to }),
  /** The sorted GUIDs of every match (generic tables); rows come from details. */
  /** A sort level goes out as its column, with "~" in front for descending. */
  query: (body: { filter?: TableFilter; sort?: SortLevel[]; limit?: number }, signal?: AbortSignal) =>
    request<{ total: number; ids: string[]; truncated: boolean; warnings?: QueryWarning[] }>("POST", "/repository/query",
      { ...body, sort: body.sort?.map((l) => (l.dir === "desc" ? "~" : "") + l.col) }, {}, signal),
  /** Check a query of the query language without running it; one that cannot be parsed is refused. */
  parseQuery: (query: string, signal?: AbortSignal) =>
    request<{ tree: unknown; warnings: QueryWarning[] }>("POST", "/repository/query/parse", { query }, {}, signal),
  details: (ids: string[], columns?: string[], signal?: AbortSignal) =>
    request<TableRows>("POST", "/artifacts/details", { ids, columns }, {}, signal),
  hid: (hid: string) => request<{ records: { guid: string; hid: string; current: boolean }[] }>("GET", "/repository/hids/" + encodeURIComponent(hid)),

  get: (guid: string) => request<View>("GET", "/artifacts/" + guid),
  create: (collection: "entries" | "documents" | "links" | "comments", body: unknown) => request<View>("POST", "/" + collection, body),
  update: (guid: string, patch: unknown, etag?: string) =>
    request<View>("PUT", "/artifacts/" + guid, patch, etag ? { "If-Match": `"${etag}"` } : {}),
  remove: (guid: string, etag?: string) => request<void>("DELETE", "/artifacts/" + guid, undefined, etag ? { "If-Match": `"${etag}"` } : {}),
  move: (guid: string, path: string) => request<View>("POST", `/artifacts/${guid}/move`, { path }),
  /** Creates a new base below an entry from fields it sets itself (one commit). */
  underlay: (guid: string, title: string, fields: string[], etag?: string) =>
    request<{ base: View; entry: View }>("POST", `/artifacts/${guid}/underlay`, { title, fields }, etag ? { "If-Match": `"${etag}"` } : {}),
  schemaOf: (guid: string) => request<{ schema: Schema | null; type: string; folder: string }>("GET", `/artifacts/${guid}/schema`),
  overlay: (guid: string) => request<OverlayView>("GET", `/artifacts/${guid}/overlay`),
  documents: (guid: string) => request<{ documents: Summary[] }>("GET", `/artifacts/${guid}/documents`),
  workflows: (guid: string) => request<{ workflows: WorkflowEval[] }>("GET", `/artifacts/${guid}/workflows`),
  transition: (guid: string, field: string, transition: string, etag?: string) =>
    request<View>("POST", `/artifacts/${guid}/transition`, { field, transition }, etag ? { "If-Match": `"${etag}"` } : {}),
  /** Everything the detail form changed, published as one commit; attachments go as multipart. */
  /** Whether an entry or document could be created from body (nothing is created). */
  check: (collection: "entries" | "documents", body: unknown) => request<{ ok: boolean; problems: string[] }>("POST", `/${collection}/check`, body),
  /** Saves; entryFiles: files of new entries (by key). created: the GUID each new entry got. */
  save: (guid: string, changes: SaveChanges, files: File[], etag?: string, entryFiles: { key: string; file: File }[] = []) => {
    let body: unknown = changes;
    if (files.length || entryFiles.length) {
      const form = new FormData();
      form.append("changes", JSON.stringify(changes));
      for (const f of files) form.append("file", f, f.name);
      for (const e of entryFiles) form.append("entryfile:" + e.key, e.file, e.file.name);
      body = form;
    }
    return request<View & { created?: Record<string, string> }>("POST", `/artifacts/${guid}/save`, body, etag ? { "If-Match": `"${etag}"` } : {});
  },
  /** A deleted artifact's last known name, if it was deleted. */
  deleted: (guid: string) => request<{ deleted: { guid: string; hid?: string; title: string }[] }>("GET", `/repository/deleted?guid=${encodeURIComponent(guid)}&limit=1`),
  relationships: (guid: string) => request<Relationships>("GET", `/artifacts/${guid}/relationships`),
  comments: (guid: string) => request<{ comments: CommentView[] }>("GET", `/artifacts/${guid}/comments`),
  /** One batch of the history, newest first; before continues after that commit. */
  history: (guid: string, before = "", limit = 50) =>
    request<{ history: HistoryEntry[]; more: boolean }>("GET", `/artifacts/${guid}/history?limit=${limit}${before ? "&before=" + before : ""}`),
  /** The artifact as it was: its content blob viewed at a commit. */
  version: (guid: string, blob: string, commit: string) =>
    request<VersionView>("GET", `/artifacts/${guid}/versions/${blob}${commit ? "?commit=" + commit : ""}`),
  versionFileUrl: (guid: string, blob: string, commit: string, name: string) =>
    `/api/artifacts/${guid}/versions/${blob}/files/${encodeURIComponent(name)}${commit ? "?commit=" + commit : ""}`,
  uploadFile: async (guid: string, name: string, file: File) => {
    const res = await fetch(`/api/artifacts/${guid}/files/${encodeURIComponent(name)}`, { method: "PUT", body: file, headers: userHeader() });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({})))?.error ?? res.statusText);
  },
  deleteFile: (guid: string, name: string) => request<void>("DELETE", `/artifacts/${guid}/files/${encodeURIComponent(name)}`),
  fileUrl: (guid: string, name: string) => `/api/artifacts/${guid}/files/${encodeURIComponent(name)}`,
  /** The content of a file, by its address on the server (fileUrl, versionFileUrl). */
  fileBlob: async (url: string): Promise<Blob> => {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`the file could not be read (${res.status})`);
    return res.blob();
  },

  effectiveSchema: (type: string, path: string) => request<Schema>("GET", "/schemas/effective" + q({ type, path })),
  workflowDef: (id: string, type: string, path: string) => request<Workflow>("GET", `/workflows/${encodeURIComponent(id)}` + q({ type, path })),
};

export type { Attachment };
