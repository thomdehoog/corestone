import { el } from "./lib/dom";
import { setTip } from "./tooltip";

/**
 * A swatch: a button (.sw) that shows a colour and picks it on a click. The
 * label names it for screen readers; the tip (setTip) is the label unless
 * given.
 */
export function swatch(color: string, pick: (color: string) => void, label = color, tip = label): HTMLButtonElement {
  const b = el("button", "sw") as HTMLButtonElement;
  b.type = "button";
  b.style.background = color;
  b.setAttribute("aria-label", label);
  setTip(b, { text: tip });
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); pick(color); });
  return b;
}

/**
 * The control for a colour of one's own: a label showing the given markup (an
 * icon) around the browser's colour input. Picking a colour there calls back
 * with it as #rrggbb.
 */
export function customColor(cls: string, iconHtml: string, picked: (color: string) => void): HTMLLabelElement {
  const picker = el("label", cls) as HTMLLabelElement;
  picker.innerHTML = iconHtml + '<input type="color" tabindex="-1" aria-label="Custom color">';
  setTip(picker, { text: "Custom color…" });
  const input = picker.querySelector("input")!;
  input.addEventListener("change", () => picked(input.value.toLowerCase()));
  picker.addEventListener("click", (e) => e.stopPropagation());
  return picker;
}

/**
 * A row of a fixed number of swatches for the colours used last; a place
 * without a colour is an empty, disabled slot (.sw.empty). Returns the slots
 * and what brings them in line with the colours again.
 */
export function recentSwatches(count: number, recent: () => string[], pick: (color: string) => void): { slots: HTMLButtonElement[]; render: () => void } {
  const slots: HTMLButtonElement[] = [];
  for (let k = 0; k < count; k++) {
    const h = el("button") as HTMLButtonElement;
    h.type = "button";
    h.addEventListener("click", (e) => { e.stopPropagation(); const v = recent()[k]; if (v) pick(v); });
    slots.push(h);
  }
  const render = () => slots.forEach((h, k) => {
    const v = recent()[k];
    h.className = "sw" + (v ? "" : " empty");
    h.style.background = v ?? "";
    h.setAttribute("aria-label", v ? "Recent color " + v : "Empty slot");
    setTip(h, v ? { text: "Recent: " + v } : null);
    h.disabled = !v;
  });
  render();
  return { slots, render };
}
