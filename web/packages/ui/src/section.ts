import { html, nothing, type TemplateResult } from "lit";

/** A short note in a section's heading, e.g. what changed in it. */
export interface SectionBadge { text: string; cls?: string }

export interface SectionOptions {
  /** Names the section in the page: its element is #sec-<id>. */
  id: string;
  title: string;
  /** How many things the section holds, shown after the title; empty for none. */
  count?: string;
  badges?: SectionBadge[];
  open: boolean;
  /** The heading was clicked: the section is to be opened (true) or closed. */
  onToggle(open: boolean): void;
  /** Controls in the heading; they stay there, so they work while the section is closed. */
  actions?: unknown;
  /** The content, asked for only while the section is open. */
  body(): unknown;
}

/** A collapsible section of a page: a heading that opens and closes it, and its content. A section with badges is marked "changed". */
export function section(o: SectionOptions): TemplateResult {
  const badges = o.badges ?? [];
  return html`<section class="section ${o.open ? "" : "collapsed"} ${badges.length ? "changed" : ""}" id=${"sec-" + o.id}><h3>
      <button class="sec-toggle" data-test=${"toggle-" + o.id} aria-expanded=${o.open} @click=${() => o.onToggle(!o.open)}>
        <span class="chev">${o.open ? "▾" : "▸"}</span>${o.title}${o.count ? html`<span class="n">${o.count}</span>` : nothing}
        ${badges.map((b) => html`<span class="change-badge ${b.cls ?? ""}" data-test="change-badge">${b.text}</span>`)}</button>
      <span class="actions">${o.actions ?? nothing}</span></h3>
      ${o.open ? o.body() : nothing}</section>`;
}
