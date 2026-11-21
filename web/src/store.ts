import type { PickOptions, RepoStatus, Summary, Theme, View } from "./types";
import { errorText, prefs } from "@corestone/ui";
import type { Account } from "./api";

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
  version: string;       // a historic version of the artifact: its content blob ("" = current)
  at: string;            // the commit that version is viewed at
}


export interface Toast { id: number; text: string; level: "info" | "error" | "success"; action?: { label: string; run: () => void } }

export interface Presence { viewers: string[]; editors: string[] }

export interface Dialog {
  kind: "new" | "pick" | "confirm" | "prompt" | "config" | "account";
  [k: string]: unknown;
}

export interface PromptOptions {
  text?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** The value is a folder path: show the folder field instead of a plain input. */
  folder?: boolean;
  /** Also offer the colour theme; choosing one applies it right away. */
  theme?: boolean;
  /** With folder: the folder being moved, which is no typo candidate. */
  ignore?: string;
}

export interface State {
  route: Route;
  status: RepoStatus | null;
  connected: boolean;
  session: string;
  user: string;
  /** The signed-in account (-auth local); null when the server runs open. */
  account: Account | null;
  theme: Theme;
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

export const defaultRoute: Route = { folder: "", guid: null, q: "", subtree: false, kind: "", type: "", tab: "", sidebars: [], expanded: false, version: "", at: "" };

type Listener = (s: State) => void;

class Store {
  state: State = {
    route: { ...defaultRoute },
    status: null,
    connected: false,
    session: "",
    user: prefs.text("corestone.user") || "",
    account: null,
    theme: applyTheme(prefs.text("corestone.theme") as Theme | null),
    selection: null,
    selectionError: null,
    loading: false,
    presence: {},
    toasts: [],
    dialog: null,
    picker: null,
    refreshTick: 0,
    navCollapsed: (prefs.text("corestone.nav") ?? (narrowScreen() ? "collapsed" : "open")) === "collapsed",
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
    prefs.setText("corestone.user", name);
    this.set({ user: name });
  }

  /** The signed-in account also names the user (presence, commits). */
  setAccount(account: Account) {
    this.set({ account, user: account.name });
  }

  setTheme(theme: Theme) {
    if (theme === "auto") prefs.remove("corestone.theme"); else prefs.setText("corestone.theme", theme);
    this.set({ theme: applyTheme(theme) });
  }

  toggleNav() {
    const c = !this.state.navCollapsed;
    prefs.setText("corestone.nav", c ? "collapsed" : "open");
    this.set({ navCollapsed: c });
  }

  /** On narrow screens the navigation is an overlay: close it after a choice. */
  closeNavIfOverlay() {
    if (narrowScreen() && !this.state.navCollapsed) this.set({ navCollapsed: true });
  }
}

/** Sets the theme on <html>; "auto" leaves it to the system preference. */
function applyTheme(theme: Theme | null): Theme {
  const t: Theme = theme === "light" || theme === "dark" ? theme : "auto";
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  return t;
}

function narrowScreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;
}

export const store = new Store();

/** Shows something that was thrown as an error toast. */
/** Opens the artifact picker for one artifact: the chosen one, or null when the picker is closed without. */
export function pickArtifact(options: PickOptions): Promise<Summary | null> {
  return new Promise((resolve) => {
    store.set({ picker: { kind: "pick", ...options, onPick: (s: Summary) => resolve(s), onCancel: () => resolve(null) } });
  });
}

export const toastError = (e: unknown) => store.toast(errorText(e), "error");
