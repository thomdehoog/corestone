/**
 * A web address a link may point to: one whose scheme cannot run code
 * (http, https, ftp, ftps, mailto; the server's model.SafeURL has the same
 * list). Returns the address without surrounding spaces, or null.
 */
export function safeHref(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!m) return null;
  return ["http", "https", "ftp", "ftps", "mailto"].includes(m[1].toLowerCase()) ? v.trim() : null;
}
