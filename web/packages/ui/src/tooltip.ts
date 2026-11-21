import { el } from "./lib/dom";

/** What a control's tooltip says: its name, its shortcut and, while it is unavailable, why. */
export interface Tip { text: string; shortcut?: string; disabled?: () => string | null }

const tips = new WeakMap<Element, Tip>();

/** Gives a control its tooltip, or takes it away with null. */
export function setTip(target: Element, tip: Tip | null): void {
  if (tip) tips.set(target, tip);
  else tips.delete(target);
}

/** The tooltip a control was given. */
export function tipOf(target: Element): Tip | undefined {
  return tips.get(target);
}

export interface TooltipOptions {
  /** The controls inside the root that may have a tooltip. */
  selector: string;
  /** How long the pointer or the focus rests on a control before the tooltip shows, in milliseconds (500). */
  delay?: number;
  /** Further classes for the tooltip's element. */
  cls?: string;
}

/**
 * Shows the tooltips (setTip) of the controls inside root, below the control,
 * after a delay on hover or focus; an unavailable control says why. Returns
 * the tooltip's element (.ui-tip in ui.css), which is the last child of root.
 */
export function attachTooltips(root: HTMLElement, o: TooltipOptions): HTMLElement {
  const tip = el("div", "ui-tip" + (o.cls ? " " + o.cls : ""));
  tip.setAttribute("role", "tooltip");
  root.append(tip);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let target: Element | null = null;
  const hide = () => { clearTimeout(timer); target = null; tip.classList.remove("on"); };
  const show = (at: Element) => {
    const it = tips.get(at);
    if (!it) return;
    const why = it.disabled?.();
    tip.replaceChildren();
    if (why) { const b = document.createElement("b"); b.textContent = "Unavailable"; tip.append(b); }
    tip.append(it.text + (it.shortcut ? ` · ${it.shortcut}` : ""));
    if (why) tip.append(document.createElement("br"), why);
    const rc = at.getBoundingClientRect();
    tip.classList.add("on");
    const w = tip.offsetWidth;
    tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, rc.left + rc.width / 2 - w / 2)) + "px";
    tip.style.top = rc.bottom + 8 + "px";
  };
  const later = (at: Element) => {
    if (at === target) return;
    clearTimeout(timer);
    tip.classList.remove("on");
    target = at;
    timer = setTimeout(() => { if (target === at) show(at); }, o.delay ?? 500);
  };
  const find = (e: Event) => { const at = (e.target as HTMLElement).closest(o.selector); return at && tips.has(at) ? at : null; };
  root.addEventListener("mouseover", (e) => { const at = find(e); if (at) later(at); else hide(); });
  root.addEventListener("mouseleave", hide);
  root.addEventListener("focusin", (e) => { const at = find(e); if (at) later(at); });
  root.addEventListener("focusout", hide);
  addEventListener("scroll", hide, true);
  return tip;
}
