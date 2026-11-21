import { html, type TemplateResult } from "lit";
import type { Theme } from "../types";

const THEMES: [Theme, string][] = [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]];

/** The choice of the colour theme: three buttons, the current one marked. */
export function themeChoice(current: Theme, choose: (theme: Theme) => void): TemplateResult {
  return html`<div class="theme-choice" role="radiogroup" aria-label="Theme"><span class="muted small">Theme</span>
    ${THEMES.map(([t, name]) => html`<button type="button" role="radio" data-theme-choice=${t} aria-checked=${current === t ? "true" : "false"}
      class="btn sm ${current === t ? "primary" : ""}" title=${t === "auto" ? "Follow the system setting" : ""} @click=${() => choose(t)}>${name}</button>`)}</div>`;
}
