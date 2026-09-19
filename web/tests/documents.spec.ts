import { answerPrompt, api, expect, get, post, seedDomain, stamp, test } from "./fixtures";

// The document editor: block operations, keyboard behaviour, nesting,
// entry cards, images from attachments, sidebars, conflicts, versions.

const id = stamp();
const folder = `docs-${id}`;

// a 1×1 transparent PNG
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test.beforeAll(async () => {
  await seedDomain(folder, "D" + id.slice(-3).toUpperCase());
});

async function newDoc(title: string) {
  return post("/documents", { path: folder, type: "spec", title, content: [{ id: "p0", type: "paragraph", text: "start" }] });
}

test("block operations: add, type, nest, reorder, delete, keyboard", async ({ page }) => {
  const d = await newDoc(`Editing ${id}`);
  await page.goto(`/artifact/${d.meta.guid}`);
  const page_ = page.locator(".doc-page");
  await expect(page_.locator("h1")).toHaveText(`Editing ${id}`);
  const first = page_.locator(".block-wrap[data-type=paragraph] .block").first();
  await expect(first).toHaveText("start");
  // Enter creates a new paragraph after the current one; typing goes into it
  await first.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second paragraph");
  await expect(page_.locator(".block-wrap[data-type=paragraph]")).toHaveCount(2);
  await expect(page_.locator(".block-wrap[data-type=paragraph] .block").nth(1)).toHaveText("second paragraph");
  // a section, then indent the second paragraph into it with Tab
  await page.locator(".doc-toolbar button", { hasText: "Section" }).click();
  await page.keyboard.type("Chapter 1");
  await expect(page_.locator(".block-wrap[data-type=section] .block.h")).toHaveText("Chapter 1");
  // toolbar inserts relative to the focused block: focus the last paragraph and add a code block
  await page_.locator(".block-wrap[data-type=paragraph] .block").nth(1).click();
  await page.locator(".doc-toolbar button", { hasText: "Code" }).click();
  await page.keyboard.type("x := 1");
  await expect(page_.locator(".block-wrap[data-type=code] .block")).toHaveText("x := 1");
  // move the code block up with the handle
  const code = page_.locator(".block-wrap[data-type=code]");
  await code.hover();
  await code.locator(".handle button[title='Move up']").click();
  const order = await page_.locator(".blocks > .block-wrap").evaluateAll((els) => els.map((e) => e.getAttribute("data-type")));
  expect(order.indexOf("code")).toBeLessThan(order.indexOf("paragraph") + 2);
  // indent the section's next sibling paragraph into the section (Tab), then outdent (Shift+Tab)
  const section = page_.locator(".block-wrap[data-type=section]");
  await section.hover();
  await section.locator(".handle button[title='Move up']").click();
  await section.locator(".handle button[title='Move up']").click();
  await section.locator(".handle button[title='Move up']").click(); // section is now first
  const after = page_.locator(".blocks > .block-wrap").nth(1);
  await after.locator(".block[contenteditable]").click();
  await page.keyboard.press("Tab");
  await expect(section.locator(".section-children .block-wrap")).toHaveCount(1);
  await section.locator(".section-children .block[contenteditable]").first().click();
  await page.keyboard.press("Shift+Tab");
  await expect(section.locator(".section-children .block-wrap")).toHaveCount(0);
  // a list with an item; Backspace on an empty paragraph removes it
  await page.locator(".doc-toolbar button", { hasText: "List" }).click();
  await page.keyboard.type("item one");
  await expect(page_.locator(".list-item .block")).toHaveText("item one");
  await page.keyboard.press("Enter"); // a new (empty) item paragraph inside the list
  await expect(page_.locator(".block-wrap[data-type=paragraph]")).toHaveCount(4);
  await page.keyboard.press("Backspace"); // empty paragraph removed again
  await expect(page_.locator(".block-wrap[data-type=paragraph]")).toHaveCount(3);
  // delete a block via its handle
  await code.hover();
  await code.locator(".handle button[title='Delete block']").click();
  await expect(page_.locator(".block-wrap[data-type=code]")).toHaveCount(0);
  // Ctrl+S saves
  await page_.locator(".block-wrap[data-type=paragraph] .block").first().click();
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast.success", { hasText: "saved" })).toBeVisible();
  type B = { type: string; title?: string; text?: string; items?: B[]; children?: B[] };
  const stored = await get<{ data: { content: B[] } }>(`/documents/${d.meta.guid}`);
  const flat = (bs: B[]): B[] => bs.flatMap((b) => [b, ...flat(b.children ?? []), ...flat(b.items ?? [])]);
  const all = flat(stored.data.content);
  const types = all.map((b) => b.type);
  expect(types).toContain("section");
  expect(types).toContain("list");
  expect(types).not.toContain("code");
  expect(all.find((b) => b.type === "section")?.title).toBe("Chapter 1");
  expect(all.find((b) => b.text === "item one")).toBeTruthy();
  await page.reload();
  await expect(page_.locator(".block-wrap[data-type=section] .block.h")).toHaveText("Chapter 1");
});

test("title edit, entry cards, images from attachments and the entry sidebar", async ({ page }) => {
  const r = await post("/entries", { path: folder, type: "req", title: `Card target ${id}`, fields: { priority: "high", effort: 4 } });
  const d = await newDoc(`Cards ${id}`);
  await fetch(`${api}/artifacts/${d.meta.guid}/files/pixel.png`, { method: "PUT", body: png });
  await page.goto(`/artifact/${d.meta.guid}`);
  // title
  const title = page.locator("[data-test=doc-title]");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" v2");
  await expect(page.locator("[data-test=save]")).toBeEnabled();
  // entry card shows fields and workflow state; clicking opens it; the sidebar shows the current entry
  await page.locator(".block-wrap[data-type=paragraph] .block").first().click();
  await page.locator("[data-test=insert-entry]").click();
  await page.locator("corestone-picker input").fill(`Card target ${id}`);
  await page.locator(".picker-results .row", { hasText: `Card target ${id}` }).click();
  const card = page.locator(`.entry-card[data-entry="${r.meta.guid}"]`);
  await expect(card).toContainText("priority");
  await expect(card).toContainText("high");
  await expect(card.locator(".pill.state")).toHaveCount(2);
  await page.locator("[data-test=sb-entry]").click();
  await expect(page.locator(".doc-side")).toContainText(`Card target ${id}`);
  await expect(page.locator(".doc-side")).toContainText("effort");
  // image from an attachment name
  await page.locator(".doc-toolbar button", { hasText: "Image" }).click();
  await answerPrompt(page, "pixel.png");
  const img = page.locator(".doc-page img.doc-image");
  await expect(img).toHaveAttribute("src", /files\/pixel\.png/);
  expect(await img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(1);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "saved" })).toBeVisible();
  const stored = await get<{ meta: { title: string }; data: { content: { type: string; src?: string; guid?: string }[] } }>(`/documents/${d.meta.guid}`);
  expect(stored.meta.title).toBe(`Cards ${id} v2`);
  expect(stored.data.content.some((b) => b.type === "image" && b.src === "pixel.png")).toBe(true);
  expect(stored.data.content.some((b) => b.type === "entry" && b.guid === r.meta.guid)).toBe(true);
  // a card whose entry disappears shows a missing marker
  await fetch(`${api}/entries/${r.meta.guid}`, { method: "DELETE" });
  await page.reload();
  await expect(page.locator(".entry-card.missing")).toContainText("missing");
});

test("sidebars: properties with schema fields, comments, relationships, versions; conflict on save", async ({ page }) => {
  const d = await newDoc(`Sidebars ${id}`);
  const other = await post("/entries", { path: folder, type: "req", title: `Related doc target ${id}`, fields: { priority: "low" } });
  await post("/links", { type: "related", source: d.meta.guid, target: other.meta.guid });
  await page.goto(`/artifact/${d.meta.guid}?sb=props,rel,comments,versions`);
  const side = page.locator(".doc-side");
  await expect(side).toContainText("Document properties");
  await expect(side.locator("[data-field=audience] select")).toBeVisible();
  await expect(side).toContainText("publish");
  await expect(side).toContainText(`Related doc target ${id}`);
  await expect(side).toContainText("created");
  // a comment from the sidebar
  await side.locator("textarea").fill("from the sidebar");
  await side.locator("button", { hasText: "Post" }).click();
  await expect(side.locator(".comment .text")).toHaveText("from the sidebar");
  // a schema field edit through the properties sidebar is saved with the document
  await side.locator("[data-field=audience] select").selectOption("customer");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/documents/${d.meta.guid}`);
  expect(stored.data.fields.audience).toBe("customer");
  // conflict: edit locally, change elsewhere, save → 412 notice with reload
  await page.locator(".block-wrap[data-type=paragraph] .block").first().click();
  await page.keyboard.type(" local");
  await page.locator("[data-test=doc-title]").click(); // blur commits the text
  const res = await fetch(`${api}/documents/${d.meta.guid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "changed elsewhere" }) });
  expect(res.ok).toBeTruthy();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".doc-main .notice.error")).toContainText("modified");
  await page.locator(".doc-main .notice.error button", { hasText: "Reload" }).click();
  await expect(page.locator("[data-test=doc-title]")).toHaveText("changed elsewhere");
  // versions list grew
  await expect(side.locator(".small", { hasText: "modified" }).first()).toBeVisible();
  // sidebars are deep-linked: turning one off updates the URL
  await page.locator("[data-test=sb-versions]").click();
  await expect(page).toHaveURL(/sb=props,rel,comments(&|$)/);
  // "Open as artifact detail" shows the document in the generic detail view
  await side.locator("button", { hasText: "Open as artifact detail" }).click();
  await expect(page).toHaveURL(/tab=general/);
});

test("document creation from the + menu starts with an empty page", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.keyboard.press("n");
  await expect(page.locator(".dialog")).toBeVisible();
  await page.locator(".type-card[data-type=spec]").click();
  await page.locator("#new-title").fill(`Fresh ${id}`);
  await page.locator(".dialog [data-field=audience] select").selectOption("internal");
  await page.locator("[data-test=create]").click();
  await expect(page.locator(".doc-page h1")).toHaveText(`Fresh ${id}`);
  await expect(page.locator(".block-wrap")).toHaveCount(1);
  await expect(page.locator("[data-test=save]")).toBeDisabled();
  await page.locator(".block-wrap .block").first().click();
  await page.keyboard.type("Hello");
  await expect(page.locator("[data-test=save]")).toBeEnabled();
  // close without saving: the artifact keeps its stored content
  await page.locator(".doc-toolbar button[title='Back to overview']").click();
  await expect(page.locator("corestone-document")).toHaveCount(0);
  await expect(page.locator("table.grid tbody tr", { hasText: `Fresh ${id}` }).locator(".kind-icon.document")).toBeVisible();
});
