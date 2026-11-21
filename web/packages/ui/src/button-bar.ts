import { el } from "./lib/dom";
import { prefs } from "./lib/prefs";
import { attachTooltips, setTip, tipOf, type Tip } from "./tooltip";

/** One choice of a split button: an icon button with its tooltip and what it does. */
export interface BarItem<S> {
  /** Names the item: remembered as the last one used, and the button's data-cmd. */
  id: string;
  /** The markup of its icon. */
  icon: string;
  tip: Tip;
  run(): void;
  /** Whether the button shows as pressed, for the state the bar is updated with. */
  pressed?(state: S): boolean;
}

export interface ButtonBarOptions<S> {
  /** The class of the bar's element. */
  cls: string;
  /** Names the bar for screen readers. */
  label: string;
  /** The markup of the icon on the part of a split button that opens its menu. */
  chevron: string;
  /** The state the buttons follow, asked for after a choice from a menu. */
  state(): S;
  /** The preference the last-used choices are kept under. */
  lastKey: string;
  /** A further class for the bar's tooltip. */
  tipCls?: string;
}

/**
 * A bar of icon buttons (.b) and split buttons (.sp: a main button, a part
 * that opens a menu, and the menu .pop). Buttons have tooltips; one that is
 * unavailable says why and does nothing. A split button's main part repeats
 * the choice used last, which is remembered. S is the state the buttons
 * follow (update).
 */
export class ButtonBar<S> {
  readonly el: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly updaters: ((state: S) => void)[] = [];
  private readonly used: Record<string, string>;

  constructor(private readonly o: ButtonBarOptions<S>) {
    this.el = el("div", o.cls);
    this.el.setAttribute("role", "toolbar");
    this.el.setAttribute("aria-label", o.label);
    this.used = prefs.json(o.lastKey, {});
    // tooltips after 0.5 s on hover or focus; unavailable buttons say why
    this.tip = attachTooltips(this.el, { selector: ".b, .c, .sz, .sw, .f", cls: o.tipCls });
    // Clicking the bar must not take the focus (and the selection) from the text.
    this.el.addEventListener("mousedown", (e) => {
      if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
    });
    document.addEventListener("click", () => this.closeMenus());
  }

  /** Adds an element at the end of the bar. */
  add(item: HTMLElement): void { this.el.insertBefore(item, this.tip); }

  /** Adds a line between two groups. */
  sep(): void { this.add(el("span", "sep")); }

  /** An icon button (not yet in the bar); while its tip gives a reason it is unavailable, a click does nothing. */
  button(id: string, icon: string, tip: Tip, act: () => void): HTMLButtonElement {
    const b = el("button", "b");
    b.type = "button";
    b.innerHTML = icon;
    b.setAttribute("aria-label", tip.text);
    b.dataset.cmd = id;
    setTip(b, tip);
    b.onclick = (e) => { e.stopPropagation(); if (tipOf(b)?.disabled?.()) return; act(); };
    return b;
  }

  /** Adds a main control with the part that opens its menu, and the menu (an element with the class pop). */
  group(main: HTMLElement, label: string, menu: HTMLElement, extra = ""): void {
    const c = el("button", "c");
    c.type = "button";
    c.innerHTML = this.o.chevron;
    c.setAttribute("aria-label", "More: " + label);
    c.setAttribute("aria-expanded", "false");
    setTip(c, { text: label + " options" });
    c.onclick = (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      this.closeMenus();
      if (open) { menu.classList.add("open"); c.setAttribute("aria-expanded", "true"); }
    };
    const w = el("div", "sp " + extra);
    w.append(main, c, menu);
    this.add(w);
  }

  closeMenus(): void {
    this.el.querySelectorAll(".pop.open").forEach((p) => p.classList.remove("open"));
    this.el.querySelectorAll(".c").forEach((c) => c.setAttribute("aria-expanded", "false"));
  }

  /** The choice remembered under a key. */
  last(key: string): string | undefined { return this.used[key]; }

  remember(key: string, value: string): void {
    this.used[key] = value;
    prefs.setJson(this.o.lastKey, this.used);
  }

  /** Adds a split button: the main part repeats the item used last (at first main0, or the first), the menu shows them all. */
  split(key: string, label: string, items: BarItem<S>[], main0?: string): void {
    const menu = el("div", "pop");
    let current = items.find((x) => x.id === this.used[key]) ?? items.find((x) => x.id === main0) ?? items[0];
    const main = this.button(current.id, current.icon, current.tip, () => current.run());
    const show = () => {
      main.innerHTML = current.icon;
      main.dataset.cmd = current.id;
      main.setAttribute("aria-label", current.tip.text);
      setTip(main, current.tip);
    };
    const buttons = items.map((it) => {
      const b = this.button(it.id, it.icon, it.tip, () => {
        it.run();
        current = it;
        this.remember(key, it.id);
        show();
        this.closeMenus();
        this.update(this.o.state());
      });
      menu.append(b);
      return b;
    });
    this.group(main, label, menu);
    this.onUpdate((s) => {
      items.forEach((it, n) => { if (it.pressed) buttons[n].setAttribute("aria-pressed", String(it.pressed(s))); });
      if (current.pressed) main.setAttribute("aria-pressed", String(current.pressed(s)));
      else main.removeAttribute("aria-pressed");
    });
  }

  /** Has a function called with the state on every update. */
  onUpdate(f: (state: S) => void): void { this.updaters.push(f); }

  /** Brings every button in line with the state. */
  update(state: S): void {
    for (const u of this.updaters) u(state);
    this.el.querySelectorAll<HTMLElement>(".b, .f").forEach((b) => {
      const r = tipOf(b)?.disabled?.();
      if (r) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
      // the reason also as the button's own hover text (when the tooltip is not shown)
      if (r) b.title = "Unavailable: " + r;
      else b.removeAttribute("title");
    });
  }
}
