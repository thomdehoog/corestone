import { button, el } from "./lib/dom";

export interface Point { x: number; y: number }

export interface OverlayOptions {
  /** The element the panels are placed in and kept inside of; it must be a positioned element. */
  root: HTMLElement;
  /**
   * The controls in a panel that take the focus when clicked (a selector, "input, select").
   * A click anywhere else in the panel leaves the focus where it is. Without it clicks are left alone.
   */
  keepFocus?: string;
  /** Asked first when Escape is pressed in a panel; true means it was used up (a popup inside closed). */
  escape?(): boolean;
  /** Called after Escape closed the panel, to give the focus back. */
  onEscape?(): void;
  /** Called whenever the panels close, also before another one opens. */
  onClose?(): void;
}

/** How a panel stands below the control that opens it. */
export interface Below {
  /** "start" (the default): left edges in line. "end": right edges in line. */
  align?: "start" | "end";
  /** The distance below the control, 4 by default. */
  gap?: number;
}

/**
 * A group of floating panels (menus, small dialogs) inside one element, of
 * which one is open at a time. A click outside the open panel or Escape in it
 * closes it.
 */
export class Overlay {
  private readonly panels: HTMLElement[] = [];
  private outside?: (e: MouseEvent) => void;

  constructor(private readonly o: OverlayOptions) {}

  /** Adds a panel to the group; it stays hidden until it is opened. */
  panel(cls: string, role: "dialog" | "menu", label?: string): HTMLElement {
    const p = el("div", cls);
    p.setAttribute("role", role);
    if (label) p.setAttribute("aria-label", label);
    p.hidden = true;
    const keep = this.o.keepFocus;
    if (keep !== undefined) p.addEventListener("mousedown", (e) => { if (!(e.target as HTMLElement).closest(keep)) e.preventDefault(); });
    p.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (this.o.escape?.()) return;
      this.close();
      this.o.onEscape?.();
    });
    this.panels.push(p);
    this.o.root.append(p);
    return p;
  }

  /** Shows a panel with its top left corner at a point of the window, moved left as far as needed to stay inside the root. */
  open(panel: HTMLElement, at: Point): void {
    this.show(panel, at);
  }

  /**
   * Shows a panel below the control that opens it: its left edges in line, or
   * with `align: "end"` its right edges (the panel then reaches to the left,
   * also beyond the root). A press on that control does not close the panel;
   * what the control's click does is the caller's (see toggle).
   */
  openBelow(panel: HTMLElement, anchor: HTMLElement, o: Below = {}): void {
    const a = anchor.getBoundingClientRect();
    this.show(panel, { x: a.left, y: a.bottom + (o.gap ?? 4) }, anchor);
    if (o.align !== "end") return;
    const r = this.o.root.getBoundingClientRect();
    panel.style.left = "auto";
    panel.style.right = `${r.right - a.right}px`;
    const over = -panel.getBoundingClientRect().left; // not beyond the window's left edge
    if (over > 0) panel.style.right = `${r.right - a.right - over}px`;
  }

  /** For the click of the control a panel belongs to: opens the panel below it, or closes it when it is open. True when it is open now. */
  toggle(panel: HTMLElement, anchor: HTMLElement, o: Below = {}): boolean {
    if (!panel.hidden) { this.close(); return false; }
    this.openBelow(panel, anchor, o);
    return true;
  }

  private show(panel: HTMLElement, at: Point, anchor?: HTMLElement): void {
    this.close();
    panel.hidden = false;
    const r = this.o.root.getBoundingClientRect();
    panel.style.right = "";
    panel.style.left = `${Math.max(0, Math.min(at.x - r.left, r.width - panel.offsetWidth))}px`;
    panel.style.top = `${at.y - r.top}px`;
    this.outside = (e) => { if (!panel.contains(e.target as Node) && !anchor?.contains(e.target as Node)) this.close(); };
    document.addEventListener("mousedown", this.outside, true);
  }

  get isOpen(): boolean { return this.panels.some((p) => !p.hidden); }

  close(): void {
    for (const p of this.panels) p.hidden = true;
    if (this.outside) document.removeEventListener("mousedown", this.outside, true);
    this.outside = undefined;
    this.o.onClose?.();
  }
}

/**
 * The head of a small dialog (.ui-head in ui.css): its title and a close button
 * showing the given markup (an icon). With `close`, a click on the button calls it.
 */
export function dialogHead(title: string, closeIcon: string, close?: () => void): { head: HTMLElement; x: HTMLButtonElement } {
  const head = el("div", "head ui-head");
  const text = el("span", "title");
  text.textContent = title;
  const x = button({ cls: "x", label: "Close", html: closeIcon, run: close });
  head.append(text, x);
  return { head, x };
}
