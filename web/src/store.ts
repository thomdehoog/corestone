import type { RepoStatus, View } from "./types";

// Central application store (design guide §7.14): every persistent UI state
// lives here; components observe it and never talk to each other.

export interface Route {
  folder: string;        // selected folder ("" = root)
  guid: string | null;   // selected artifact
  q: string;             // search query
  subtree: boolean;      // include nested folders
  kind: string;          // kind filter ("" = entries+documents)
  type: string;          // type filter
  tab: string;           // detail section / document sidebar
  sidebars: string[];    // visible document sidebars
  expanded: boolean;     // detail fills the workspace
}

export interface Toast { id: number; text: string; level: "info" | "error" | "success"; action?: { label: string; run: () => void } }

export interface Presence { viewers: string[]; editors: string[] }

export interface Dialog {
  kind: "new" | "pick" | "confirm" | "prompt" | "config";
  [k: string]: unknown;
}

export interface PromptOptions {
  text?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** The value is a folder path: show the folder field instead of a plain input. */
  folder?: boolean;
  /** With folder: the folder being moved, which is no typo candidate. */
  ignore?: string;
}

export interface State {
  route: Route;
  status: RepoStatus | null;
  connected: boolean;
  session: string;
  user: string;
  selection: View | null;
  selectionError: string | null;
  loading: boolean;
  presence: Record<string, Presence>;
  toasts: Toast[];
  dialog: Dialog | null;
  picker: Dialog | null; // an artifact picker shown above the current dialog
  refreshTick: number;
  navCollapsed: boolean;
}

export const defaultRoute: Route = { folder: "", guid: null, q: "", subtree: false, kind: "", type: "", tab: "", sidebars: [], expanded: false };

type Listener = (s: State) => void;

class Store {
  state: State = {
    route: { ...defaultRoute },
    status: null,
    connected: false,
    session: "",
    user: localStorage.getItem("corestone.user") || "",
    selection: null,
    selectionError: null,
    loading: false,
    presence: {},
    toasts: [],
    dialog: null,
    picker: null,
    refreshTick: 0,
    navCollapsed: (localStorage.getItem("corestone.nav") ?? (narrowScreen() ? "collapsed" : "open")) === "collapsed",
  };
  private listeners = new Set<Listener>();
  private toastSeq = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  setRoute(patch: Partial<Route>) {
    this.set({ route: { ...this.state.route, ...patch } });
  }

  toast(text: string, level: Toast["level"] = "info", action?: Toast["action"]) {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts, { id, text, level, action }] });
    window.setTimeout(() => this.dismiss(id), level === "error" ? 9000 : 4000);
  }

  dismiss(id: number) {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  /** Asks the user for one line of text; resolves null when cancelled. */
  prompt(title: string, opts: PromptOptions = {}): Promise<string | null> {
    return new Promise((resolve) => {
      this.set({ dialog: { kind: "prompt", title, ...opts, onSubmit: (v: string) => resolve(v), onCancel: () => resolve(null) } });
    });
  }

  refresh() {
    this.set({ refreshTick: this.state.refreshTick + 1 });
  }

  setUser(name: string) {
    localStorage.setItem("corestone.user", name);
    this.set({ user: name });
  }

  toggleNav() {
    const c = !this.state.navCollapsed;
    localStorage.setItem("corestone.nav", c ? "collapsed" : "open");
    this.set({ navCollapsed: c });
  }

  /** On narrow screens the navigation is an overlay: close it after a choice. */
  closeNavIfOverlay() {
    if (narrowScreen() && !this.state.navCollapsed) this.set({ navCollapsed: true });
  }
}

function narrowScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;
}

export const store = new Store();
