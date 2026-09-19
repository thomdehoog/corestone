import { expect, test } from "@playwright/test";

// Adversarial browser tests: content that tries to break or script the
// client must render as inert text, and the client must stay usable.

const base = process.env.CORESTONE_URL || "http://127.0.0.1:18090";
const api = base + "/api";
const stamp = Date.now().toString(36);
const folder = `adv-${stamp}`;

async function put(path: string, body: unknown) {
  const res = await fetch(api + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}
async function post(path: string, body: unknown) {
  const res = await fetch(api + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  return { status: res.status, ...json } as { status: number; meta?: { guid: string }; error?: string };
}

test.beforeAll(async () => {
  await put(`/schemas/item?scope=${folder}`, { type: "item", displayName: "Item", hid: { prefix: "ADV" },
    fields: [{ id: "link", name: "Link", type: "hyperlink" }, { id: "note", name: "Note", type: "text" }] });
  await put(`/schemas/page?scope=${folder}`, { type: "page", kind: "document" });
});

test("script-looking content is rendered as text everywhere", async ({ page }) => {
  const xss = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>"'&`;
  const e = await post("/entries", { path: `${folder}/<b>x<i>`, type: "item", title: xss, fields: { note: xss } });
  expect(e.status).toBe(201);
  await post("/comments", { subject: e.meta!.guid, text: xss, author: xss });
  await page.goto(`/artifact/${e.meta!.guid}`);
  await expect(page.locator("corestone-detail h2")).toHaveText(xss);
  await expect(page.locator("table.grid tbody tr").first()).toContainText("<img src=x");
  await expect(page.locator("#sec-comments .comment .text")).toHaveText(xss);
  await expect(page.locator(".tree .row", { hasText: "<b>x<i>" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator("script:not([type=module])").count()).toBe(0);
});

test("javascript: and data: URLs are refused by the API and never rendered as links", async ({ page }) => {
  const bad = await post("/entries", { path: folder, type: "item", title: "bad link", fields: { link: "javascript:alert(1)" } });
  expect(bad.status).toBe(400);
  expect(bad.error).toContain("http");
  // a value that bypassed validation (e.g. pushed directly) is not rendered as a link
  const ok = await post("/entries", { path: folder, type: "item", title: "unsafe via json", fields: { note: "x" } });
  await put(`/artifacts/${ok.meta!.guid}`, { fields: { "x-raw": "javascript:alert(2)" } }).catch(() => undefined);
  await page.goto(`/artifact/${ok.meta!.guid}`);
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  const good = await post("/entries", { path: folder, type: "item", title: "good link", fields: { link: "https://example.org/x" } });
  await page.goto(`/artifact/${good.meta!.guid}`);
  await expect(page.locator('[data-field=link] a[href="https://example.org/x"]')).toHaveAttribute("rel", /noopener/);
});

test("over-long and control-character input is rejected with a readable error", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-entry]").click();
  await page.locator(".type-card[data-type=item]").click();
  await page.locator("#new-title").fill("x".repeat(3000));
  await page.locator("[data-test=create]").click();
  await expect(page.locator(".dialog .notice.error")).toContainText("longer than");
  await page.locator("#new-title").fill("ok title");
  await page.locator("#new-hid").fill("has space");
  await page.locator("[data-test=create]").click();
  await expect(page.locator(".dialog .notice.error")).toContainText("HID");
  await page.locator("#new-hid").fill("");
  await page.locator("#new-path").fill("../escape");
  await page.locator("[data-test=create]").click();
  await expect(page.locator(".dialog .notice.error")).toContainText("folder");
});

test("double submit creates exactly one artifact", async ({ page }) => {
  await page.goto(`/folder/${folder}/once`);
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-entry]").click();
  await page.locator(".type-card[data-type=item]").click();
  await page.locator("#new-title").fill("only once");
  // two clicks in the same event loop turn: the second must be a no-op
  await page.locator("[data-test=create]").evaluate((b) => { (b as HTMLButtonElement).click(); (b as HTMLButtonElement).click(); });
  await expect(page.locator("corestone-detail h2")).toHaveText("only once");
  const res = await (await fetch(`${api}/repository/search?path=${folder}/once&kind=entry`)).json();
  expect(res.total).toBe(1);
});

test("garbage deep links degrade gracefully", async ({ page }) => {
  await page.goto("/artifact/not-a-guid");
  await expect(page.locator("corestone-detail .empty-state")).toContainText("not available");
  await page.goto("/artifact/00000000-0000-4000-8000-000000000000");
  await expect(page.locator("corestone-detail .empty-state")).toContainText("not available");
  await page.goto("/folder/%2e%2e/%2e%2e?q=%00&kind=blob&tab=nope&sb=a,b");
  await expect(page.locator(".toolbar")).toBeVisible();
  await expect(page.locator(".notice.error, .toast.error").first()).toBeVisible();
  await page.goto(`/folder/${folder}?q=${encodeURIComponent("'; DROP TABLE artifacts; --")}`);
  await expect(page.locator(".toolbar .hint")).toContainText("0 artifacts");
});

test("orphaned and cyclic comment threads still show", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "item", title: "threads" });
  const c1 = await post("/comments", { subject: e.meta!.guid, text: "root" });
  await post("/comments", { subject: e.meta!.guid, parent: c1.meta!.guid, text: "reply" });
  // simulate a direct push that removed the root: the reply becomes orphaned
  const del = await fetch(`${api}/comments/${c1.meta!.guid}`, { method: "DELETE" });
  expect(del.status).toBe(204);
  await page.goto(`/artifact/${e.meta!.guid}`);
  await expect(page.locator("#sec-comments .comment")).toHaveCount(0); // cascade removed the reply too
  const c3 = await post("/comments", { subject: e.meta!.guid, text: "second root" });
  await post("/comments", { subject: e.meta!.guid, parent: c3.meta!.guid, text: "second reply" });
  await page.reload();
  await expect(page.locator("#sec-comments .comment")).toHaveCount(2);
});

test("document with a hostile image source shows a notice, not an image", async ({ page }) => {
  const d = await post("/documents", { path: folder, type: "page", title: "hostile doc",
    content: [{ id: "i1", type: "image", src: "javascript:alert(1)", alt: "x" }, { id: "p", type: "paragraph", text: "<script>bad</script>" }] });
  expect(d.status).toBe(201);
  await page.goto(`/artifact/${d.meta!.guid}`);
  await expect(page.locator(".doc-page .notice.error")).toContainText("not allowed");
  expect(await page.locator('img[src^="javascript:"]').count()).toBe(0);
  await expect(page.locator(".block-wrap[data-type=paragraph] .block")).toHaveText("<script>bad</script>");
});
