import { test as base, expect, type Page } from "@playwright/test";

// Shared harness: an API helper bound to the server under test, a unique
// folder per spec, and a guard that fails any test in which the page
// threw an uncaught exception.

export const base_url = process.env.CORESTONE_URL || "http://127.0.0.1:18090";
export const api = base_url + "/api";

/** Sends a write, honouring 503 + Retry-After (maintenance mode) like a well-behaved client. */
async function write(method: string, path: string, body: unknown) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(api + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 503 && attempt < 40) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
export async function put(path: string, body: unknown) {
  return write("PUT", path, body);
}
export async function post<T = { meta: { guid: string; hid?: string; folder: string }; etag: string }>(path: string, body: unknown): Promise<T> {
  return write("POST", path, body) as Promise<T>;
}
export async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(api + path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
export async function del(path: string) {
  const res = await fetch(api + path, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${path}: ${res.status}`);
}

/** Answers the in-app prompt dialog (store.prompt) with a value. */
export async function answerPrompt(page: import("@playwright/test").Page, value: string) {
  const input = page.locator(".dialog input[data-test=prompt]");
  await input.waitFor();
  await input.fill(value);
  await input.press("Enter");
  await page.locator(".dialog.prompt").waitFor({ state: "detached" });
}

export function stamp(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

/** A workflow + entry/document/link types under one scope. */
export async function seedDomain(scope: string, prefix: string) {
  await put(`/workflows/dev?scope=${scope}`, { id: "dev", name: "Development", initial: "open", states: ["open", "review", "done"],
    transitions: [{ id: "submit", name: "Submit for review", from: "open", to: "review" }, { id: "approve", name: "Approve", from: "review", to: "done" }, { id: "rework", from: "review", to: "open" }] });
  await put(`/workflows/publish?scope=${scope}`, { id: "publish", name: "Publishing", initial: "draft", states: ["draft", "released"],
    transitions: [{ id: "release", from: "draft", to: "released" }, { id: "withdraw", from: "released", to: "draft" }] });
  await put(`/schemas/req?scope=${scope}`, { type: "req", displayName: "Requirement", hid: { prefix }, workflows: ["dev", "publish"],
    fields: [{ id: "priority", name: "Priority", type: "enum", required: true, options: [{ value: "low" }, { value: "high" }] },
             { id: "rationale", name: "Rationale", type: "multiline" }, { id: "effort", name: "Effort", type: "integer" }],
    presentation: { columns: ["priority", "effort"] } });
  await put(`/schemas/tc?scope=${scope}`, { type: "tc", displayName: "Test case", hid: { prefix: prefix + "T" } });
  await put(`/schemas/spec?scope=${scope}`, { type: "spec", kind: "document", displayName: "Specification", workflows: ["publish"],
    fields: [{ id: "audience", name: "Audience", type: "enum", options: [{ value: "internal" }, { value: "customer" }] }] });
  await put(`/schemas/verifies?scope=${scope}`, { type: "verifies", kind: "link", displayName: "verifies", sourceTypes: ["tc"], targetTypes: ["req"], cardinality: "many-to-many",
    fields: [{ id: "coverage", name: "Coverage", type: "enum", options: [{ value: "full" }, { value: "partial" }] }] });
  await put(`/schemas/related?scope=${scope}`, { type: "related", kind: "link", displayName: "related to" });
}

export const test = base.extend<{ errors: string[] }>({
  errors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(errors);
    expect(errors, "uncaught page errors").toEqual([]);
  }, { auto: true }],
});

export { expect };
export type { Page };

/** Waits until the artifact overview shows the given title. */
export async function rowWithTitle(page: Page, title: string) {
  const row = page.locator("table.grid tbody tr", { hasText: title });
  await expect(row).toHaveCount(1);
  return row;
}
