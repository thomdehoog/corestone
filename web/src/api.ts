import type {
  Attachment, CommentView, Issue, LogEntry, OverlayView, Relationships, RepoStatus, Schema, Summary, Tree, View, Workflow, WorkflowEval,
} from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Names the configured user so the server records them as commit author. */
function userHeader(): Record<string, string> {
  let user = "";
  try {
    user = localStorage.getItem("corestone.user") || "";
  } catch {
    /* storage unavailable */
  }
  return user ? { "X-Corestone-User": encodeURIComponent(user) } : {};
}

async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const init: RequestInit = { method, headers: { ...userHeader(), ...headers } };
  if (body !== undefined) {
    if (typeof body === "string") {
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
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? res.statusText;
    throw new ApiError(res.status, msg);
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

export const api = {
  status: () => request<RepoStatus>("GET", "/repository"),
  tree: (path: string, subtree: boolean, limit = 500) => request<Tree>("GET", "/repository/tree" + q({ path, subtree, limit })),
  search: (params: { q?: string; kind?: string; type?: string; path?: string; subtree?: boolean; limit?: number; [k: string]: string | number | boolean | undefined }) =>
    request<{ artifacts: Summary[]; total: number }>("GET", "/repository/search" + q(params)),
  types: (path: string) => request<{ types: Schema[] }>("GET", "/repository/types" + q({ path })),
  validate: () => request<{ issues: Issue[]; errors: number; warnings: number }>("GET", "/repository/validate"),
  reindex: () => request<{ started: boolean }>("POST", "/repository/reindex"),
  moveFolder: (from: string, to: string) => request<{ moved: number }>("POST", "/repository/folders/move", { from, to }),
  hid: (hid: string) => request<{ records: { guid: string; hid: string; current: boolean }[] }>("GET", "/repository/hids/" + encodeURIComponent(hid)),

  get: (guid: string) => request<View>("GET", "/artifacts/" + guid),
  create: (collection: "entries" | "documents" | "links" | "comments", body: unknown) => request<View>("POST", "/" + collection, body),
  update: (guid: string, patch: unknown, etag?: string) =>
    request<View>("PUT", "/artifacts/" + guid, patch, etag ? { "If-Match": `"${etag}"` } : {}),
  remove: (guid: string, etag?: string) => request<void>("DELETE", "/artifacts/" + guid, undefined, etag ? { "If-Match": `"${etag}"` } : {}),
  move: (guid: string, path: string) => request<View>("POST", `/artifacts/${guid}/move`, { path }),
  schemaOf: (guid: string) => request<{ schema: Schema | null; type: string; folder: string }>("GET", `/artifacts/${guid}/schema`),
  overlay: (guid: string) => request<OverlayView>("GET", `/artifacts/${guid}/overlay`),
  workflows: (guid: string) => request<{ workflows: WorkflowEval[] }>("GET", `/artifacts/${guid}/workflows`),
  transition: (guid: string, workflow: string, to: string, etag?: string) =>
    request<View>("POST", `/artifacts/${guid}/transition`, { workflow, to }, etag ? { "If-Match": `"${etag}"` } : {}),
  relationships: (guid: string) => request<Relationships>("GET", `/artifacts/${guid}/relationships`),
  comments: (guid: string) => request<{ comments: CommentView[] }>("GET", `/artifacts/${guid}/comments`),
  history: (guid: string) => request<{ history: LogEntry[] }>("GET", `/artifacts/${guid}/history`),
  uploadFile: async (guid: string, name: string, file: File) => {
    const res = await fetch(`/api/artifacts/${guid}/files/${encodeURIComponent(name)}`, { method: "PUT", body: file, headers: userHeader() });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({})))?.error ?? res.statusText);
  },
  deleteFile: (guid: string, name: string) => request<void>("DELETE", `/artifacts/${guid}/files/${encodeURIComponent(name)}`),
  fileUrl: (guid: string, name: string) => `/api/artifacts/${guid}/files/${encodeURIComponent(name)}`,

  effectiveSchema: (type: string, path: string) => request<Schema>("GET", "/schemas/effective" + q({ type, path })),
  schemas: () => request<{ schemas: { path: string; scope: string; name: string; valid: boolean; error?: string; definition?: Schema }[] }>("GET", "/schemas"),
  putSchema: (type: string, scope: string, def: unknown) => request<Schema>("PUT", `/schemas/${encodeURIComponent(type)}` + q({ scope }), def),
  workflowDef: (id: string, path: string) => request<Workflow>("GET", `/workflows/${encodeURIComponent(id)}` + q({ path })),
  workflowFiles: () => request<{ workflows: { path: string; scope: string; name: string; valid: boolean; definition?: Workflow }[] }>("GET", "/workflows"),
  putWorkflow: (id: string, scope: string, def: unknown) => request<Workflow>("PUT", `/workflows/${encodeURIComponent(id)}` + q({ scope }), def),
};

export type { Attachment };
