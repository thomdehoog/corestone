import { LitElement, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { store, type State } from "./store";

@customElement("corestone-toasts")
export class Toasts extends LitElement {
  private unsub?: () => void;
  private s!: State;
  override createRenderRoot() { return this; }
  override connectedCallback() {
    super.connectedCallback();
    this.unsub = store.subscribe((s) => { this.s = s; this.requestUpdate(); });
  }
  override disconnectedCallback() { this.unsub?.(); super.disconnectedCallback(); }
  override render() {
    if (!this.s?.toasts.length) return nothing;
    return html`<div class="toasts">${this.s.toasts.map((t) => html`
      <div class="toast ${t.level}" role="status">
        <span class="text">${t.text}</span>
        ${t.action ? html`<button class="btn sm" @click=${() => { t.action!.run(); store.dismiss(t.id); }}>${t.action.label}</button>` : nothing}
        <button class="btn sm icon" @click=${() => store.dismiss(t.id)} aria-label="Dismiss">✕</button>
      </div>`)}</div>`;
  }
}
