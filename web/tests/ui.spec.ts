import { expect, test, type Page } from "@playwright/test";

// Browser tests of the generic client against a live corestone. They exercise
// the MVP success criteria (design guide §9.9) through the UI only: define
// types (via the API, as an application would), create and edit entries,
// compose documents from entries, navigate relationships, create overlays,
// drive workflows, and share deep links.

const base = process.env.CORESTONE_URL || "http://127.0.0.1:18090";
const api = base + "/api";
const stamp = Date.now().toString(36);
const folder = `ui-${stamp}`;

async function put(path: string, body: unknown) {
  const res = await fetch(api + path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
}
async function post(path: string, body: unknown): Promise<{ meta: { guid: string; hid?: string } }> {
  const res = await fetch(api + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

test.beforeAll(async () => {
  await put(`/workflows/dev?scope=${folder}`, { id: "dev", initial: "open", states: ["open", "review", "done"],
    transitions: [{ id: "submit", name: "Submit for review", from: "open", to: "review" }, { id: "approve", from: "review", to: "done" }] });
  await put(`/schemas/req?scope=${folder}`, { type: "req", displayName: "Requirement", hid: { prefix: "UR" + stamp.slice(-3).toUpperCase() }, workflows: ["dev"],
    fields: [{ id: "priority", name: "Priority", type: "enum", required: true, options: [{ value: "low" }, { value: "high" }] },
             { id: "rationale", name: "Rationale", type: "multiline" }, { id: "effort", name: "Effort", type: "integer" }] });
  await put(`/schemas/tc?scope=${folder}`, { type: "tc", displayName: "Test case", hid: { prefix: "UT" + stamp.slice(-3).toUpperCase() } });
  await put(`/schemas/spec?scope=${folder}`, { type: "spec", kind: "document", displayName: "Specification" });
  await put(`/schemas/verifies?scope=${folder}`, { type: "verifies", kind: "link", sourceTypes: ["tc"], targetTypes: ["req"], cardinality: "many-to-many" });
});

async function openFolder(page: Page) {
  await page.goto(`/folder/${folder}`);
  await expect(page.locator(".toolbar .title")).toHaveText(folder);
}

test("create an entry through the + button with a schema-generated form", async ({ page }) => {
  await openFolder(page);
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-entry]").click();
  // the dialog offers the types visible here (only entry types for "Entry…")
  await expect(page.locator(".type-card[data-type=req]")).toBeVisible();
  await expect(page.locator(".type-card[data-type=tc]")).toBeVisible();
  await expect(page.locator(".type-card[data-type=spec]")).toHaveCount(0);
  await page.locator(".type-card[data-type=req]").click();
  // an empty form generated from the effective schema
  await expect(page.locator("#new-title")).toBeFocused();
  await expect(page.locator("#new-path")).toHaveValue(folder);
  const dlg = page.locator(".dialog");
  await expect(dlg.locator("[data-field=priority] select")).toBeVisible();
  await expect(dlg.locator("[data-field=rationale] textarea")).toBeVisible();
  await expect(dlg.locator("[data-field=effort] input[type=number]")).toBeVisible();
  // validation comes from the Foundation: required field missing → error shown, dialog stays
  await page.locator("#new-title").fill("Boot fast");
  await page.locator("[data-test=create]").click();
  await expect(dlg.locator(".notice.error")).toContainText("required");
  await dlg.locator("[data-field=priority] select").selectOption("high");
  await dlg.locator("[data-field=effort] input").fill("5");
  await dlg.locator("[data-field=rationale] textarea").fill("Latency sells.");
  await page.locator("[data-test=create]").click();
  // created: dialog closes, the detail opens, the row is in the table with its generated HID
  await expect(page.locator(".dialog")).toHaveCount(0);
  await expect(page.locator("corestone-detail h2")).toHaveText("Boot fast");
  await expect(page.locator("corestone-detail .detail-head .hid")).toContainText("UR");
  await expect(page.locator("table.grid tbody tr", { hasText: "Boot fast" })).toHaveCount(1);
  await expect(page).toHaveURL(/\/artifact\/[0-9a-f-]{36}/);
});

test("edit fields, save with optimistic concurrency, and see history", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: "Editable", fields: { priority: "low" } });
  await page.goto(`/artifact/${e.meta.guid}`);
  await expect(page.locator("corestone-detail h2")).toHaveText("Editable");
  await page.locator("[data-test=title]").fill("Editable (v2)");
  await page.locator("[data-field=effort] input").fill("3");
  await expect(page.locator(".savebar .dirty")).toBeVisible();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success")).toContainText("Saved");
  await expect(page.locator(".savebar")).toHaveCount(0);
  await expect(page.locator("corestone-detail h2")).toHaveText("Editable (v2)");
  // while a draft is being edited, a concurrent change elsewhere is announced,
  // and saving is rejected (412) without losing the draft
  await page.locator("[data-test=title]").fill("my version");
  const res = await fetch(`${api}/artifacts/${e.meta.guid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "changed elsewhere" }) });
  expect(res.ok).toBeTruthy();
  await expect(page.locator(".toast.error").first()).toContainText("changed by someone else");
  await expect(page.locator("[data-test=title]")).toHaveValue("my version");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".notice.error")).toContainText("modified");
  await expect(page.locator("[data-test=title]")).toHaveValue("my version");
  await page.locator(".notice.error .btn", { hasText: "Reload" }).click();
  await expect(page.locator("[data-test=title]")).toHaveValue("changed elsewhere");
  await page.locator(".quicklinks a", { hasText: "History" }).click();
  await expect(page.locator("#sec-history .history-row").first()).toContainText("modified");
  await expect(page.locator("#sec-history .history-row").last()).toContainText("created");
});

test("workflow transitions from the detail view", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: "Workflow item", fields: { priority: "low" } });
  await page.goto(`/artifact/${e.meta.guid}`);
  const wf = page.locator(".workflow[data-workflow=dev]");
  await expect(wf.locator(".pill.state")).toHaveText("open");
  await expect(wf.locator("select option")).toHaveCount(2); // placeholder + submit
  await wf.locator("select").selectOption("submit");
  await expect(page.locator(".toast.success")).toContainText("now review");
  await expect(wf.locator(".pill.state")).toHaveText("review");
  await wf.locator("button", { hasText: "diagram" }).click();
  await expect(wf.locator(".wf-state.current")).toHaveText("review");
  await expect(page.locator("table.grid tbody tr", { hasText: "Workflow item" }).locator(".pill.state")).toHaveText("review");
});

test("relationships: link two artifacts and navigate between them", async ({ page }) => {
  const r = await post("/entries", { path: folder, type: "req", title: `Linked requirement ${stamp}`, fields: { priority: "low" } });
  const t = await post("/entries", { path: folder, type: "tc", title: `Linked test ${stamp}` });
  await page.goto(`/artifact/${t.meta.guid}`);
  await page.locator("#sec-relationships .actions button", { hasText: "verifies" }).click();
  await page.locator("corestone-picker input").fill(`Linked requirement ${stamp}`);
  await page.locator(".picker-results .row", { hasText: `Linked requirement ${stamp}` }).click();
  await expect(page.locator(".toast.success")).toContainText("Link created");
  const row = page.locator("#sec-relationships .link-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("verifies");
  await row.locator("a").click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Linked requirement ${stamp}`);
  await expect(page.locator("#sec-relationships .link-row")).toContainText(`Linked test ${stamp}`);
  void r;
});

test("comments are threaded", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: "Discussed", fields: { priority: "low" } });
  await page.goto(`/artifact/${e.meta.guid}`);
  await page.locator("[data-test=comment-text]").fill("First!");
  await page.locator("[data-test=comment-send]").click();
  await expect(page.locator("#sec-comments .comment")).toHaveCount(1);
  await page.locator("#sec-comments .comment a", { hasText: "reply" }).click();
  await page.locator("[data-test=comment-text]").fill("Second, as a reply");
  await page.locator("[data-test=comment-send]").click();
  await expect(page.locator("#sec-comments .comment.reply")).toHaveCount(1);
  await expect(page.locator("#sec-comments .comment.reply .text")).toHaveText("Second, as a reply");
});

test("overlays: create a variant and see inherited fields", async ({ page }) => {
  const b = await post("/entries", { path: folder, type: "req", title: "Base requirement", fields: { priority: "high", rationale: "shared" } });
  await page.goto(`/artifact/${b.meta.guid}`);
  await page.locator("#sec-overlay button", { hasText: "Create variant" }).click();
  await expect(page.locator(".dialog h2")).toContainText("New Requirement");
  await expect(page.locator(".dialog .ref-chip")).toContainText("Base requirement");
  await page.locator("#new-title").fill("Variant A");
  await page.locator(".dialog [data-field=priority] select").selectOption("low");
  await page.locator("[data-test=create]").click();
  await expect(page.locator("corestone-detail h2")).toHaveText("Variant A");
  await expect(page.locator("#sec-overlay .chain .node")).toHaveCount(2);
  await expect(page.locator("[data-field=rationale] .inherited")).toContainText("inherited");
  await expect(page.locator("[data-field=rationale] textarea")).toHaveValue("");
  await expect(page.locator("#sec-overlay")).toContainText("shared");
});

test("documents: compose from entries and edit in the block editor", async ({ page }) => {
  const r = await post("/entries", { path: folder, type: "req", title: `Referenced in doc ${stamp}`, fields: { priority: "low" } });
  await openFolder(page);
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-document]").click();
  await page.locator(".type-card[data-type=spec]").click();
  await page.locator("#new-title").fill("My spec");
  await page.locator("[data-test=create]").click();
  await expect(page.locator(".doc-page h1")).toHaveText("My spec");
  await page.locator(".doc-toolbar button", { hasText: "Section" }).click();
  await page.locator('.block-wrap[data-type=section] .block[contenteditable]').first().fill("Timing");
  await page.locator("[data-test=insert-entry]").click();
  await page.locator("corestone-picker input").fill(`Referenced in doc ${stamp}`);
  await page.locator(".picker-results .row", { hasText: `Referenced in doc ${stamp}` }).click();
  await expect(page.locator(`.entry-card[data-entry="${r.meta.guid}"]`)).toContainText(`Referenced in doc ${stamp}`);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "saved" })).toBeVisible();
  await page.reload();
  await expect(page.locator(".doc-page h1")).toHaveText("My spec");
  await expect(page.locator(".entry-card")).toHaveCount(1);
  await expect(page.locator(".block-wrap[data-type=section] .block.h")).toHaveText("Timing");
  // sidebars are part of the deep link
  await page.locator("[data-test=sb-props]").click();
  await expect(page).toHaveURL(/sb=props/);
  await expect(page.locator(".doc-side")).toContainText("Document properties");
  // clicking the entry card opens the entry
  await page.locator(".entry-card").click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Referenced in doc ${stamp}`);
});

test("search, filters, subtree toggle and deep links", async ({ page }) => {
  await post("/entries", { path: folder + "/sub", type: "req", title: "Needle in the subfolder", fields: { priority: "high" } });
  await openFolder(page);
  // direct folder listing does not include the subfolder
  await expect(page.locator("table.grid tbody tr", { hasText: "Needle" })).toHaveCount(0);
  await page.locator("[data-test=subtree]").check();
  await expect(page.locator("table.grid tbody tr", { hasText: "Needle" })).toHaveCount(1);
  await expect(page).toHaveURL(/subtree=1/);
  await page.locator("[data-test=search]").fill("needle");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toolbar .title")).toContainText("needle");
  await expect(page.locator("table.grid tbody tr")).toHaveCount(1);
  // the folder tree shows the subfolder and selecting it narrows the view
  await page.locator(`.tree .row[data-folder="${folder}/sub"]`).click();
  await expect(page.locator(".toolbar .title")).toHaveText("sub");
  // by-type navigation
  await page.locator(".tree .row[data-type=req]").click();
  await expect(page.locator(".toolbar .title")).toContainText("Requirement");
  await expect(page).toHaveURL(/type=req/);
  // reloading the deep link restores the same state
  const url = page.url();
  await page.goto(url);
  await expect(page.locator(".toolbar .title")).toContainText("Requirement");
});

test("delete removes the artifact and its links", async ({ page }) => {
  const r = await post("/entries", { path: folder, type: "req", title: `Doomed ${stamp}`, fields: { priority: "low" } });
  const t = await post("/entries", { path: folder, type: "tc", title: `Doomed test ${stamp}` });
  await post("/links", { type: "verifies", source: t.meta.guid, target: r.meta.guid });
  await page.goto(`/artifact/${r.meta.guid}`);
  await page.locator("[data-test=delete]").click();
  await expect(page.locator(".dialog")).toContainText("1 link");
  await page.locator(".dialog .btn.danger").click();
  await expect(page.locator(".toast.success")).toContainText("Deleted");
  await expect(page.locator("table.grid tbody tr", { hasText: "Doomed" })).toHaveCount(1); // only the test case remains
  const res = await fetch(`${api}/artifacts/${r.meta.guid}`);
  expect(res.status).toBe(404);
});
