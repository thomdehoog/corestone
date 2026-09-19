import { answerPrompt, api, expect, get, post, seedDomain, stamp, test } from "./fixtures";

// Workflows, relationships, overlays, HID renames, moves and folder moves.

const id = stamp();
const folder = `rel-${id}`;
const prefix = "R" + id.slice(-3).toUpperCase();

test.beforeAll(async () => {
  await seedDomain(folder, prefix);
});

test("two independent workflows on one artifact, with diagram and rework", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: "Two workflows", fields: { priority: "low" } });
  await page.goto(`/artifact/${e.meta.guid}`);
  const dev = page.locator(".workflow[data-workflow=dev]");
  const pub = page.locator(".workflow[data-workflow=publish]");
  await expect(dev.locator(".pill.state")).toHaveText("open");
  await expect(pub.locator(".pill.state")).toHaveText("draft");
  await pub.locator("select").selectOption("release");
  await expect(pub.locator(".pill.state")).toHaveText("released");
  await expect(dev.locator(".pill.state")).toHaveText("open"); // untouched
  await dev.locator("select").selectOption("submit");
  await expect(dev.locator(".pill.state")).toHaveText("review");
  await expect(dev.locator("select option")).toHaveCount(3); // placeholder + approve + rework
  await dev.locator("select").selectOption("rework");
  await expect(dev.locator(".pill.state")).toHaveText("open");
  await dev.locator("button", { hasText: "diagram" }).click();
  await expect(dev.locator(".wf-state")).toHaveCount(3);
  await expect(dev.locator(".wf-state.current")).toHaveText("open");
  await expect(dev.locator(".wf-edge", { hasText: "open → review" })).toBeVisible();
  await dev.locator("button", { hasText: "diagram" }).click();
  await expect(dev.locator(".wf-diagram")).toHaveCount(0);
  const stored = await get<{ meta: { workflows: Record<string, string> } }>(`/entries/${e.meta.guid}`);
  expect(stored.meta.workflows).toEqual({ dev: "open", publish: "released" });
  await expect(page.locator("#sec-history .history-row", { hasText: "transitioned from review to open" })).toHaveCount(1);
});

test("relationships: typed links both ways, removal, free-form type, and endpoint rules", async ({ page }) => {
  const r1 = await post("/entries", { path: folder, type: "req", title: `Req A ${id}`, fields: { priority: "low" } });
  const r2 = await post("/entries", { path: folder, type: "req", title: `Req B ${id}`, fields: { priority: "low" } });
  const t1 = await post("/entries", { path: folder, type: "tc", title: `Test A ${id}` });
  await page.goto(`/artifact/${r1.meta.guid}`);
  const rel = page.locator("#sec-relationships");
  // a requirement can only be the target of "verifies": the button is offered as incoming
  await expect(rel.locator(".actions button", { hasText: "verifies" })).toContainText("←");
  await rel.locator(".actions button", { hasText: "verifies" }).click();
  await page.locator("corestone-picker input").fill(`Test A ${id}`);
  await page.locator(".picker-results .row", { hasText: `Test A ${id}` }).click();
  await expect(rel.locator(".link-row")).toHaveCount(1);
  await expect(rel.locator(".link-row .arrow")).toHaveText("←");
  // free-form "related" link via the prompt
  await rel.locator(".actions button", { hasText: "other" }).click();
  await answerPrompt(page, "related");
  await page.locator("corestone-picker input").fill(`Req B ${id}`);
  await page.locator(".picker-results .row", { hasText: `Req B ${id}` }).click();
  await expect(rel.locator(".link-row")).toHaveCount(2);
  await expect(rel.locator(".link-row", { hasText: "related" }).locator(".arrow")).toHaveText("→");
  // the other side sees it incoming; social column counts links
  await page.goto(`/artifact/${r2.meta.guid}`);
  await expect(page.locator("#sec-relationships .link-row", { hasText: "related" }).locator(".arrow")).toHaveText("←");
  await expect(page.locator("table.grid tbody tr", { hasText: `Req B ${id}` }).locator(".social")).toContainText("⇄ 1");
  // removing a link
  await page.locator("#sec-relationships .link-row button").click();
  await expect(page.locator("#sec-relationships .link-row")).toHaveCount(0);
  await expect(page.locator("table.grid tbody tr", { hasText: `Req B ${id}` }).locator(".social")).toContainText("⇄ 0");
  // endpoint rule violation surfaces as a toast, not a silent failure
  await page.goto(`/artifact/${t1.meta.guid}`);
  await page.locator("#sec-relationships .actions button", { hasText: "other" }).click();
  await answerPrompt(page, "verifies");
  await page.locator("corestone-picker input").fill(`Test A ${id}`); // a test case as target of verifies is not allowed
  await expect(page.locator(".picker-results")).toContainText("No matching"); // itself is excluded
  await page.locator("corestone-picker input").fill(`Req A ${id}`);
  await page.locator(".picker-results .row", { hasText: `Req A ${id}` }).click();
  await expect(page.locator(".toast.error")).toContainText("already exists"); // duplicate of the first link
});

test("overlays: three levels, per-field origin, override and revert", async ({ page }) => {
  const base = await post("/entries", { path: folder, type: "req", title: `Base ${id}`, fields: { priority: "high", rationale: "from base", effort: 8 } });
  const mid = await post("/entries", { path: folder, type: "req", title: `Mid ${id}`, base: base.meta.guid, fields: { effort: 5 } });
  const leaf = await post("/entries", { path: folder, type: "req", title: `Leaf ${id}`, base: mid.meta.guid, fields: {} });
  await page.goto(`/artifact/${leaf.meta.guid}`);
  const ov = page.locator("#sec-overlay");
  await expect(ov.locator(".chain .node")).toHaveCount(3);
  await expect(ov.locator(".chain .node.self")).toContainText("this entry");
  await expect(ov).toContainText("effort: 5");
  await expect(ov).toContainText("rationale: from base");
  await expect(page.locator("[data-field=effort] .inherited")).toBeVisible();
  await expect(page.locator("[data-field=priority] select")).toHaveValue("");
  // override effort locally
  await page.locator("[data-field=effort] input").fill("3");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(page.locator("[data-field=effort] .inherited")).toHaveCount(0);
  await expect(ov).toContainText("effort: 3");
  // clearing it reverts to the inherited value
  await page.locator("[data-field=effort] input").fill("");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(page.locator("[data-field=effort] .inherited")).toBeVisible();
  await expect(ov).toContainText("effort: 5");
  // the base lists its variants; navigating the chain works
  await ov.locator(".chain .node a").first().click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Base ${id}`);
  await expect(page.locator("#sec-overlay")).toContainText("Variants deriving");
  await expect(page.locator("#sec-overlay a", { hasText: `Mid ${id}` })).toBeVisible();
});

test("HID rename keeps history and lookup; move keeps identity", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: "Renamed", fields: { priority: "low" } });
  const oldHid = e.meta.hid!;
  await page.goto(`/artifact/${e.meta.guid}`);
  await page.locator("#d-hid").fill(`${prefix}-9000`);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(page.locator(".detail-head .hid")).toHaveText(`${prefix}-9000`);
  await expect(page.locator("#sec-history .history-row", { hasText: `renamed to ${prefix}-9000` })).toHaveCount(1);
  const lookup = await get<{ records: { guid: string; current: boolean }[] }>(`/repository/hids/${oldHid}`);
  expect(lookup.records[0].guid).toBe(e.meta.guid);
  expect(lookup.records[0].current).toBe(false);
  // a duplicate HID is refused with the owner named
  const other = await post("/entries", { path: folder, type: "req", title: "Other", fields: { priority: "low" } });
  await page.goto(`/artifact/${other.meta.guid}`);
  await page.locator("#d-hid").fill(`${prefix}-9000`);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".notice.error")).toContainText("already used");
  // move through the prompt: folder tree and breadcrumbs follow, identity stays
  await page.locator(".detail-head button", { hasText: "Move" }).click();
  await answerPrompt(page, `${folder}/moved`);
  await expect(page.locator(".toast.success")).toContainText("Moved");
  await expect(page.locator("#sec-general")).toContainText(`${folder}/moved`);
  await expect(page.locator(".tree .row[data-folder='" + folder + "/moved']")).toBeVisible();
  await expect(page.locator("header .crumbs")).toContainText("moved");
  await expect(page).toHaveURL(new RegExp(`artifact/${other.meta.guid}`));
});

test("folder move from the toolbar relocates the subtree", async ({ page }) => {
  await post("/entries", { path: `${folder}/old/deep`, type: "req", title: `Deep one ${id}`, fields: { priority: "low" } });
  await page.goto(`/folder/${folder}/old`);
  await page.locator("[data-test=move-folder]").click();
  await answerPrompt(page, `${folder}/new`);
  await expect(page.locator(".toast.success")).toContainText("Moved");
  await expect(page).toHaveURL(new RegExp(`/folder/${folder}/new`));
  await expect(page.locator(".tree .row[data-folder='" + folder + "/new/deep']")).toBeVisible();
  await page.locator("[data-test=subtree]").check();
  await expect(page.locator("table.grid tbody tr", { hasText: `Deep one ${id}` })).toHaveCount(1);
  const search = await get<{ total: number }>(`/repository/search?path=${folder}/old&subtree=1`);
  expect(search.total).toBe(0);
});

test("delete asks for confirmation and can be cancelled", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `Keep me ${id}`, fields: { priority: "low" } });
  await page.goto(`/artifact/${e.meta.guid}`);
  await page.locator("[data-test=delete]").click();
  await expect(page.locator(".dialog")).toContainText("Delete");
  await page.locator(".dialog button", { hasText: "Cancel" }).click();
  await expect(page.locator(".dialog")).toHaveCount(0);
  await expect(page.locator("corestone-detail h2")).toHaveText(`Keep me ${id}`);
  await page.locator("[data-test=delete]").click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".dialog")).toHaveCount(0);
  const still = await fetch(`${api}/entries/${e.meta.guid}`);
  expect(still.status).toBe(200);
});
