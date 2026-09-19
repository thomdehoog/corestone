import { answerPrompt, api, expect, get, post, seedDomain, stamp, test } from "./fixtures";

// Navigation and shell behaviour: keyboard shortcuts, breadcrumbs,
// history navigation, deep links, filters, kind chips, columns, sorting,
// collapse state, responsive layout, dark mode, status and reindex.

const id = stamp();
const folder = `nav-${id}`;
const guids: Record<string, string> = {};

test.beforeAll(async () => {
  await seedDomain(folder, "N" + id.slice(-3).toUpperCase());
  const a = await post("/entries", { path: `${folder}/alpha`, type: "req", title: `Alpha one ${id}`, fields: { priority: "high", effort: 1 } });
  const b = await post("/entries", { path: `${folder}/beta`, type: "req", title: `Beta two ${id}`, fields: { priority: "low", effort: 2 } });
  const t = await post("/entries", { path: `${folder}/alpha`, type: "tc", title: `Gamma test ${id}` });
  const d = await post("/documents", { path: `${folder}/beta`, type: "spec", title: `Delta doc ${id}` });
  await post("/links", { type: "verifies", source: t.meta.guid, target: a.meta.guid });
  await post("/comments", { subject: a.meta.guid, text: "note", author: "nav" });
  Object.assign(guids, { a: a.meta.guid, b: b.meta.guid, t: t.meta.guid, d: d.meta.guid });
});

test("keyboard shortcuts, breadcrumbs and browser history", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.keyboard.press("/");
  await expect(page.locator("[data-test=search]")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.locator("body").click({ position: { x: 700, y: 700 } });
  await page.keyboard.press("n");
  await expect(page.locator(".dialog")).toContainText("What do you want to create");
  await page.keyboard.press("Escape");
  await expect(page.locator(".dialog")).toHaveCount(0);
  // breadcrumbs
  await page.locator(`.tree .row[data-folder="${folder}/alpha"]`).click();
  await expect(page.locator("header .crumbs")).toContainText("alpha");
  await page.locator("header .crumbs a", { hasText: folder }).click();
  await expect(page.locator(".toolbar .title")).toHaveText(folder);
  // open an artifact, Escape closes it, back reopens it
  await page.locator(`.tree .row[data-folder="${folder}/alpha"]`).click();
  await page.locator("table.grid tbody tr", { hasText: `Alpha one ${id}` }).click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Alpha one ${id}`);
  await page.locator("body").click({ position: { x: 700, y: 60 } });
  await page.keyboard.press("Escape");
  await expect(page.locator("corestone-detail")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Alpha one ${id}`);
  await page.goBack();
  await expect(page.locator("corestone-detail")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Alpha one ${id}`);
  // the header brand goes home
  await page.locator("header .brand").click();
  await expect(page.locator(".toolbar .title")).toHaveText("Repository");
});

test("deep links: section tab, expanded layout, folder context", async ({ page }) => {
  await page.goto(`/artifact/${guids.a}?tab=history&x=1`);
  await expect(page.locator(".quicklinks a.active")).toHaveText(/History/);
  await expect(page.locator("corestone-overview")).toBeHidden();
  await expect(page.locator(".tree .row.selected")).toContainText("alpha"); // folder inferred from the artifact
  await page.locator(".detail-head button[title='Restore layout']").click();
  await expect(page.locator("corestone-overview")).toBeVisible();
  await expect(page).not.toHaveURL(/x=1/);
  await page.locator(".quicklinks a", { hasText: "Comments" }).click();
  await expect(page).toHaveURL(/tab=comments/);
  await expect(page.locator("#sec-comments .comment")).toHaveCount(1);
  // the ✕ closes and drops the tab from the URL
  await page.locator(".detail-head button[title=Close]").click();
  await expect(page).not.toHaveURL(/tab=/);
});

test("overview: kind chips, schema columns, subtree, sorting stability, social counts", async ({ page }) => {
  await page.goto(`/folder/${folder}?subtree=1`);
  const table = page.locator("table.grid");
  await expect(table.locator("thead")).toContainText("Priority");
  await expect(table.locator("thead")).toContainText("Effort");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const alpha = table.locator("tbody tr", { hasText: `Alpha one ${id}` });
  await expect(alpha).toContainText("high");
  await expect(alpha.locator(".social")).toContainText("⇄ 1 · ✎ 1");
  await page.locator(".chip", { hasText: "Documents" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr .kind-icon.document")).toBeVisible();
  await page.locator(".chip", { hasText: "Links" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr")).toContainText("verifies");
  await page.locator(".chip", { hasText: "Comments" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await page.locator(".chip", { hasText: "Entries + Docs" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(4);
  await page.locator("[data-test=subtree]").uncheck();
  await expect(page.locator("corestone-overview .empty-state")).toContainText("Nothing here yet");
  // by-type counts in the sidebar reflect the subtree
  await expect(page.locator(".tree .row[data-type=req] .count")).toHaveText("2");
  await page.locator(".tree .row[data-type=tc]").click();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator(".toolbar .title")).toContainText("Test case");
});

test("search: text, HID, results across folders, clearing", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("[data-test=search]").fill("gamma");
  await expect(page.locator(".toolbar .title")).toContainText("gamma");
  await expect(page.locator("table.grid tbody tr")).toHaveCount(1);
  const hid = (await (await fetch(`${api}/entries/${guids.b}`)).json()).meta.hid as string;
  await page.locator("[data-test=search]").fill(hid);
  await expect(page.locator("table.grid tbody tr", { hasText: `Beta two ${id}` })).toHaveCount(1);
  await page.locator("[data-test=search]").fill("");
  await expect(page.locator(".toolbar .title")).toHaveText(folder);
  await expect(page).not.toHaveURL(/q=/);
});

test("navigation collapse persists; responsive layout; dark mode", async ({ page, browser }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("header button[title='Toggle navigation']").click();
  await expect(page.locator("corestone-sidebar")).toBeHidden();
  await page.reload();
  await expect(page.locator("corestone-sidebar")).toBeHidden();
  await page.locator("header button[title='Toggle navigation']").click();
  await expect(page.locator("corestone-sidebar")).toBeVisible();
  // phone-sized viewport: no horizontal overflow, table still usable
  await page.goto(`/folder/${folder}/alpha`);
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator("corestone-sidebar")).toBeVisible(); // overlays the content on small screens
  await page.locator(".nav-scrim").click({ position: { x: 700, y: 400 } }); // tapping beside the overlay closes it
  await expect(page.locator("corestone-sidebar")).toBeHidden();
  await page.locator("table.grid tbody tr").first().click();
  await expect(page.locator("corestone-detail h2")).toBeVisible();
  const overflow = await page.evaluate(() => document.querySelector(".shell")!.scrollWidth - document.querySelector(".shell")!.clientWidth);
  expect(overflow).toBe(0);
  // a first visit on a phone starts with the navigation closed; choosing a folder closes it again
  const phone = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const small = await phone.newPage();
  await small.goto(`/folder/${folder}?subtree=1`);
  await expect(small.locator("corestone-sidebar")).toBeHidden();
  await expect(small.locator("table.grid tbody tr").first()).toBeVisible();
  await small.locator("header button[title='Toggle navigation']").click();
  await expect(small.locator("corestone-sidebar")).toBeVisible();
  await small.locator(`.tree .row[data-folder='${folder}/alpha']`).click();
  await expect(small.locator("corestone-sidebar")).toBeHidden();
  await expect(small).toHaveURL(new RegExp(`/folder/${folder}/alpha`));
  await small.locator("table.grid tbody tr").first().click();
  await expect(small.locator("corestone-detail h2")).toBeVisible();
  await phone.close();
  // dark mode renders with dark background and readable text
  const ctx = await browser.newContext({ colorScheme: "dark", viewport: { width: 1200, height: 800 } });
  const dark = await ctx.newPage();
  await dark.goto(`/artifact/${guids.a}`);
  await expect(dark.locator("corestone-detail h2")).toHaveText(`Alpha one ${id}`);
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toMatch(/rgb\((\d+), (\d+), (\d+)\)/);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeLessThan(200);
  await ctx.close();
});

test("status indicator, user name and reindex", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await expect(page.locator("header .status")).toContainText("in sync", { timeout: 20000 });
  await page.locator("header button[title='Set your name']").click();
  await answerPrompt(page, "Zoë");
  await expect(page.locator("header button[title='Set your name']")).toHaveText("Zoë");
  await page.reload();
  await expect(page.locator("header button[title='Set your name']")).toHaveText("Zoë");
  const before = (await get<{ projection: { lastRebuild?: string } }>("/repository")).projection.lastRebuild ?? "";
  await page.locator("header button", { hasText: "Reindex" }).click();
  await expect(page.locator(".toast", { hasText: "Reindex started" })).toBeVisible();
  // wait for the rebuild itself to finish, not just for the header to look calm
  await expect.poll(async () => (await get<{ projection: { lastRebuild?: string } }>("/repository")).projection.lastRebuild ?? "", { timeout: 60000 }).not.toBe(before);
  await expect(page.locator("header .status")).toContainText("in sync", { timeout: 20000 });
  await expect(page.locator("table.grid tbody tr, .empty-state").first()).toBeVisible();
  // a large folder still lists and filters quickly
  const many = Array.from({ length: 120 }, (_, i) => post("/entries", { path: `${folder}/bulk`, type: "req", title: `Bulk ${i} ${id}`, fields: { priority: "low", effort: i } }));
  await Promise.all(many);
  await page.locator(`.tree .row[data-folder="${folder}/bulk"]`).click();
  await expect(page.locator(".toolbar .hint")).toContainText("120 artifacts");
  await expect(page.locator("table.grid tbody tr")).toHaveCount(120);
  await page.locator("[data-test=search]").fill(`Bulk 7 ${id}`);
  await expect(page.locator("table.grid tbody tr")).toHaveCount(1);
});

test("the divider between overview and detail can be dragged, keyed, reset, and is remembered", async ({ page }) => {
  await page.goto(`/folder/${folder}/alpha`);
  const overview = page.locator("corestone-overview");
  const bar = page.locator("[data-test=splitter]");
  const height = async () => (await overview.boundingBox())!.height;
  const initial = await height();
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 153, { steps: 5 });
  await page.mouse.up();
  expect(await height()).toBeGreaterThan(initial + 120);
  const dragged = await height();
  await page.reload();
  await expect.poll(height).toBeCloseTo(dragged, -1);
  await bar.focus();
  await page.keyboard.press("ArrowUp");
  expect(await height()).toBeLessThan(dragged);
  await bar.dblclick();
  await expect.poll(height).toBeCloseTo(initial, -1);
  // hidden when the detail view is expanded
  await page.goto(`/artifact/${guids.a}?x=1`);
  await expect(page.locator("corestone-detail h2")).toHaveText(`Alpha one ${id}`);
  await expect(bar).toBeHidden();
  expect((await page.locator("corestone-detail").boundingBox())!.height).toBeGreaterThan(300);
});
