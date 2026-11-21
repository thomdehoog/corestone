// Types mirrored from the REST API. Domain knowledge (which fields exist,
// which workflows apply) never lives here: it is read from schemas.

export type Kind = "entry" | "document" | "link" | "comment";

export interface Summary {
  guid: string;
  kind: Kind;
  type: string;
  title?: string;
  hid?: string;
  folder: string;
  path: string;
  base?: string;
  source?: string;
  target?: string;
  subject?: string;
  parent?: string;
  author?: string;
  excerpt?: string;
  created?: string;
  fields?: Record<string, unknown>;
  etag?: string;
  createdAt?: string;
  modifiedAt?: string;
  links: number;
  comments: number;
}

export interface View {
  meta: Summary;
  data: Record<string, unknown>;
  etag: string;
  attachments?: Attachment[];
}

export interface Attachment {
  name: string;
  path: string;
  etag: string;
  size: number;
}

export type FieldType =
  | "hid" | "boolean" | "integer" | "float" | "currency" | "date" | "time" | "datetime"
  | "text" | "multiline" | "richtext" | "enum" | "hyperlink" | "reference" | "references"
  | "attachment" | "json" | "workflow";

export interface IconPresentation { icon?: string; color?: string; backgroundColor?: string }
export interface EnumOption { value: string; label?: string; presentation?: IconPresentation }

export interface Field {
  id: string;
  name?: string;
  type: FieldType;
  multiple?: boolean;
  required?: boolean;
  options?: EnumOption[];
  extendable?: boolean;
  /** A dynamic enumeration: the options are artifacts, a value is the chosen artifact's GUID. */
  source?: { kind: "entry" | "document"; types: string[]; query?: string; sort?: string[] };
  currency?: string;
  workflow?: string;
  targetTypes?: string[];
  description?: string;
  default?: unknown;
  presentation?: Record<string, unknown>;
}

export interface Schema {
  type: string;
  kind: Kind;
  displayName?: string;
  description?: string;
  hid?: { prefix: string; separator?: string; digits?: number };
  fields?: Field[];
  sourceTypes?: string[];
  targetTypes?: string[];
  cardinality?: string;
  /** Links: the name read from the target ("verified by"). */
  reverseName?: string;
  /** Document types: the entry types "Convert selection to entry" makes. */
  entryTypes?: string[];
  presentation?: Record<string, unknown>;
  sources?: string[];
}

export interface WorkflowState { id: string; name?: string; presentation?: IconPresentation; final?: boolean }
/** A transition is named by its id: it is what a save sends; the server runs it. */
export interface Transition { id: string; name?: string; from: string[]; to: string }
export interface Workflow {
  id: string;
  name?: string;
  description?: string;
  initial: string;
  states: WorkflowState[];
  transitions: Transition[];
  scope?: string;
}

/** The value of a workflow field, written by the server: the state, the transition that led to it, the state before. */
export interface WorkflowValue { state: string; transition?: string; previous?: string }

/** A workflow field of an artifact evaluated: id and name are the field's; available are the transitions allowed now. */
export interface WorkflowEval { id: string; name: string; definition: Workflow; state: string; transition?: string; previous?: string; available: Transition[] }

/** A link seen from one endpoint; role is the display name, or the reverse name when incoming. */
export interface LinkView { link: Summary; other: Summary; role?: string }
export interface Relationships {
  incoming: LinkView[];
  outgoing: LinkView[];
  allowedAsSource: Schema[];
  allowedAsTarget: Schema[];
}

export interface CommentView { meta: Summary; data: Record<string, unknown> }

export interface OverlayLevel { guid: string; title?: string; hid?: string; fields: string[] }
export interface OverlayView {
  chain: OverlayLevel[];
  fields: Record<string, unknown>;
  origin: Record<string, string>;
  overlays: Summary[];
}

export interface LogEntry {
  sha: string;
  author: string;
  email: string;
  time: string;
  subject: string;
  body?: string;
  trailers?: Record<string, string>;
}

/** A commit in an artifact's history; blob addresses the artifact's version then ("" or absent: it did not exist). */
export interface HistoryEntry extends LogEntry {
  blob?: string;
  /** Links created here that repeat a deleted link (same type and endpoints), with its last version. */
  recreates?: { link: string; prior: string; blob?: string; at?: string; deletedAt?: string; deletedBy?: string }[];
}

/** An artifact as it was at one commit (read-only); configuration is today's. */
export interface VersionView extends View {
  commit: LogEntry;
  exact: boolean;   // false: shown at the commit that introduced this content
  exists: boolean;  // the artifact still exists today
  schema?: Schema | null;
  overlay?: { chain: OverlayLevel[]; fields: Record<string, unknown>; origin: Record<string, string> } | null;
  baseOverlay?: { chain: OverlayLevel[]; fields: Record<string, unknown>; origin: Record<string, string> } | null;
  workflows: WorkflowEval[];
  relationships: Relationships;
  comments: CommentView[];
  /** A link's endpoints as they were then (null: did not exist then). */
  endpoints?: { source: Summary | null; target: Summary | null };
  /** What a comment was on, as it was then; a link comes with its endpoints and role name. */
  subject?: { meta: Summary; source?: Summary | null; target?: Summary | null; role?: string };
  /** What this version's commit changed, compared with just before it. */
  change?: VersionChange;
}

export interface VersionChange {
  created?: boolean;
  restored?: boolean; // brought back after a deletion
  changed: string[];  // title, hid, text, …, fields.<id>
  added: string[];    // links and comments that came to point here
  removedLinks?: number;
  removedComments?: number;
}

export interface FolderInfo { name: string; path: string; artifacts: number; direct: number; hasConfig: boolean }
export interface Tree { folder: string; folders: FolderInfo[]; artifacts: Summary[]; total: number }

export interface ProjectionStatus {
  processedHash: string;
  maintenance: boolean;
  lastRebuild?: string;
  reason?: string;
  phase?: string;
  progress: number;
  total: number;
  lastError?: string;
  capabilities: { lookup: boolean; query: boolean; search: boolean };
}

export interface RepoStatus {
  branch: string;
  head: string;
  projection: ProjectionStatus;
  inSync: boolean;
  stats?: { artifacts: Record<string, number>; types: Record<string, number>; invalid: number; deleted: number; folders: number; schemas: number; workflows: number };
  /** Configuration problems: invalid files the server ignores (code invalid-config) and unresolved references (config-reference). */
  invalidConfig?: Issue[];
}

export interface Issue { severity: "error" | "warning"; code: string; guid?: string; path?: string; message: string }

/** One level of a table sort; col is an overview column id ("$hid", …) or a field id. */
export interface SortLevel { col: string; dir: "asc" | "desc" }

/** The filter of a generic table query; types may hold "<kind>/*". */
export interface TableFilter {
  q?: string;
  /** A query in the query language, combined with the rest by AND. */
  query?: string; path?: string; subtree?: boolean; kind?: Kind[]; type?: string; types?: string[]; hid?: string;
  fields?: Record<string, string>; states?: Record<string, string>; valid?: boolean;
}

/** A criterion of a query that cannot match as written. */
export interface QueryWarning { pos: number; message: string }

/** Table rows, the artifacts they point at, and type display names by folder and type. */
export interface TableRows {
  artifacts: Summary[];
  related: Record<string, Summary>;
  typeNames: Record<string, Record<string, string>>;
}

/** What the artifact picker offers when one artifact is to be chosen. */
export interface PickOptions {
  title: string;
  kinds?: Kind[];
  /** Type ids; "<kind>/*" allows every type of a kind. */
  types?: string[];
  /** Narrows what is offered, in the query language. */
  query?: string;
  /** An artifact that is not offered (its GUID). */
  exclude?: string;
}

/** A picker footer action besides picking a row; "add" shows a green ＋, "remove" a red ✕. */
export interface PickerAction { label: string; test: string; tone: "add" | "remove"; run: () => void }

/** The colour theme; "auto" follows the system setting. */
export type Theme = "auto" | "light" | "dark";
