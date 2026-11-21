import { html, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { Field, Kind, Schema, Summary, WorkflowValue } from "../types";
import { plainText, type RichText } from "@corestone/editor/model";
import { kindPictogram } from "./icons";

export const kindLabel: Record<Kind, string> = { entry: "Entry", document: "Document", link: "Link", comment: "Comment" };
export const kindPlural: Record<Kind, string> = { entry: "Entries", document: "Documents", link: "Links", comment: "Comments" };
export const collectionOf: Record<Kind, "entries" | "documents" | "links" | "comments"> = {
  entry: "entries", document: "documents", link: "links", comment: "comments",
};

export function label(s: Summary | undefined | null): string {
  if (!s) return "(missing)";
  return s.title || s.hid || s.guid.slice(0, 8);
}

/** "HID – title" where both exist, else the plain label. */
export function hidLabel(s: Summary | undefined | null): string {
  return s?.hid && s.title ? `${s.hid} – ${s.title}` : label(s);
}

/** The markup of a kind's icon, for what is not rendered by Lit: its pictogram on a small tile in the kind's colour. */
export function kindMark(kind: Kind): string {
  return `<span class="kind-icon ${kind}">${kindPictogram(kind)}</span>`;
}

export function kindIcon(kind: Kind, title: string = kindLabel[kind]): TemplateResult {
  return html`<span class="kind-icon ${kind}" role="img" aria-label=${title} title=${title}>${unsafeSVG(kindPictogram(kind))}</span>`;
}

export function displayName(s: Schema | undefined, type: string): string {
  return s?.displayName || type;
}

export function folderCrumbs(folder: string): { name: string; path: string }[] {
  const out = [{ name: "Repository", path: "" }];
  const parts = folder.split("/").filter(Boolean);
  parts.forEach((p, i) => out.push({ name: p, path: parts.slice(0, i + 1).join("/") }));
  return out;
}

/** Whether a field value is rich text in blocks (a list of paragraphs with text, and tables); see internal/model/richtext.go. */
export function isRichText(v: unknown): v is RichText {
  return Array.isArray(v) && v.length > 0 && v.every((b) => !!b && typeof b === "object" && ("text" in b || "table" in b));
}

/** Whether a field value is a workflow field's: an object holding the state. */
export function isWorkflowValue(v: unknown): v is WorkflowValue {
  return !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as WorkflowValue).state === "string"
    && Object.keys(v).every((k) => k === "state" || k === "transition" || k === "previous");
}

/** The workflow fields among field values: field id and state. */
export function workflowStates(fields: Record<string, unknown> | undefined | null): [string, string][] {
  return Object.entries(fields ?? {}).flatMap(([id, v]) => (isWorkflowValue(v) ? [[id, v.state] as [string, string]] : []));
}

/** A field value as one text: rich text as it reads, a workflow as its state, other objects as JSON. */
export function showValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (isRichText(v)) return plainText(v);
  if (isWorkflowValue(v)) return v.state;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/** The comment type a folder offers: "comment" when defined, else the first comment type. */
export function commentTypeOf(types: Schema[]): string | null {
  const comments = types.filter((t) => t.kind === "comment");
  return comments.find((t) => t.type === "comment")?.type ?? comments[0]?.type ?? null;
}

/** A stand-in definition to display a stored field its type does not define. */
export function undeclaredField(id: string, value: unknown): Field {
  return { id, name: id, type: typeof value === "object" && value !== null ? "json" : typeof value === "boolean" ? "boolean" : "text" };
}
