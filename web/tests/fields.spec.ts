import { test, expect, put, post, get, seedDomain, stamp, api } from "./fixtures";

// Every generic field type through the schema-generated form, attachments,
// and the reference pickers.

const id = stamp();
const folder = `fields-${id}`;
let target: { guid: string; title: string };

test.beforeAll(async () => {
  await seedDomain(folder, "F" + id.slice(-3).toUpperCase());
  await put(`/schemas/all?scope=${folder}`, { type: "all", displayName: "Everything", hid: { prefix: "ALL" },
    fields: [
      { id: "flag", name: "Flag", type: "boolean" },
      { id: "count", name: "Count", type: "integer" },
      { id: "ratio", name: "Ratio", type: "float" },
      { id: "price", name: "Price", type: "currency", currency: "EUR" },
      { id: "day", name: "Day", type: "date" },
      { id: "at", name: "At", type: "time" },
      { id: "when", name: "When", type: "datetime" },
      { id: "line", name: "Line", type: "text", description: "one line" },
      { id: "para", name: "Paragraph", type: "multiline" },
      { id: "rich", name: "Rich", type: "richtext" },
      { id: "one", name: "One of", type: "enum", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
      { id: "many", name: "Many of", type: "enum", multiple: true, options: [{ value: "x" }, { value: "y" }, { value: "z" }] },
      { id: "free", name: "Free enum", type: "enum", extendable: true, options: [{ value: "known" }] },
      { id: "url", name: "URL", type: "hyperlink" },
      { id: "ref", name: "Reference", type: "reference", targetTypes: ["req"] },
      { id: "refs", name: "References", type: "references" },
      { id: "file", name: "File", type: "attachment" },
      { id: "blob", name: "JSON", type: "json" },
      { id: "def", name: "Defaulted", type: "text", default: "preset" },
    ] });
  const r = await post("/entries", { path: folder, type: "req", title: `Ref target ${id}`, fields: { priority: "low" } });
  target = { guid: r.meta.guid, title: `Ref target ${id}` };
});

test("all field types round-trip through the generated form", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-entry]").click();
  await page.locator(".type-card[data-type=all]").click();
  const d = page.locator(".dialog");
  await expect(d.locator("[data-field=def] input")).toHaveValue("preset");
  await expect(d.locator("[data-field=line] .help")).toHaveText("one line");
  await d.locator("#new-title").fill("Everything filled");
  await d.locator("[data-field=flag] input[type=checkbox]").check();
  await d.locator("[data-field=count] input").fill("42");
  await d.locator("[data-field=ratio] input").fill("0.75");
  await d.locator("[data-field=price] input").fill("19.99");
  await expect(d.locator("[data-field=price]")).toContainText("EUR");
  await d.locator("[data-field=day] input").fill("2026-12-24");
  await d.locator("[data-field=at] input").fill("13:45");
  await d.locator("[data-field=when] input").fill("2026-12-24T10:30");
  await d.locator("[data-field=line] input").fill("single line");
  await d.locator("[data-field=para] textarea").fill("first line\nsecond line");
  await d.locator("[data-field=rich] textarea").fill("rich *text*");
  await d.locator("[data-field=one] select").selectOption("b");
  await d.locator("[data-field=many] label", { hasText: "x" }).locator("input").check();
  await d.locator("[data-field=many] label", { hasText: "z" }).locator("input").check();
  await d.locator("[data-field=free] input").fill("brand-new");
  await d.locator("[data-field=url] input").fill("https://example.org/spec");
  await d.locator("[data-field=blob] textarea").fill('{"nested": {"n": 1}, "list": [1, 2]}');
  await d.locator("[data-field=blob] textarea").blur();
  // reference through the picker (restricted to req)
  await d.locator("[data-field=ref] button", { hasText: "Select" }).click();
  await page.locator("corestone-picker input").fill(target.title);
  await page.locator(".picker-results .row", { hasText: target.title }).click();
  await expect(d.locator("[data-field=ref] .ref-chip")).toContainText(target.title);
  // multi reference: pick twice (same artifact is deduplicated)
  await d.locator("[data-field=refs] button").click();
  await page.locator("corestone-picker input").fill(target.title);
  await page.locator(".picker-results .row", { hasText: target.title }).click();
  await expect(d.locator("[data-field=refs] .ref-chip")).toHaveCount(1);
  await d.locator("[data-test=create]").click();
  await expect(page.locator("corestone-detail h2")).toHaveText("Everything filled");
  const guid = page.url().match(/artifact\/([0-9a-f-]{36})/)![1];
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${guid}`);
  expect(stored.data.fields).toMatchObject({
    flag: true, count: 42, ratio: 0.75, price: 19.99, day: "2026-12-24", at: "13:45", line: "single line",
    para: "first line\nsecond line", rich: "rich *text*", one: "b", many: ["x", "z"], free: "brand-new",
    url: "https://example.org/spec", ref: target.guid, refs: [target.guid], blob: { nested: { n: 1 }, list: [1, 2] }, def: "preset",
  });
  expect(String(stored.data.fields.when)).toMatch(/^2026-12-24T/);
  // the detail renders every value back
  const f = page.locator("corestone-detail");
  await expect(f.locator("[data-field=flag] input")).toBeChecked();
  await expect(f.locator("[data-field=count] input")).toHaveValue("42");
  await expect(f.locator("[data-field=one] select")).toHaveValue("b");
  await expect(f.locator("[data-field=many] label", { hasText: "z" }).locator("input")).toBeChecked();
  await expect(f.locator("[data-field=free] input")).toHaveValue("brand-new");
  await expect(f.locator("[data-field=url] a")).toHaveAttribute("href", "https://example.org/spec");
  await expect(f.locator("[data-field=ref] .ref-chip")).toContainText(target.title);
  await expect(f.locator("[data-field=blob] textarea")).toHaveValue(/"nested"/);
  // editing: uncheck, clear, change enum, remove reference, invalid JSON is refused
  await f.locator("[data-field=flag] input").uncheck();
  await f.locator("[data-field=count] input").fill("");
  await f.locator("[data-field=one] select").selectOption("");
  await f.locator("[data-field=ref] .ref-chip button").click();
  await f.locator("[data-field=blob] textarea").fill("{not json");
  await f.locator("[data-field=blob] textarea").blur();
  await expect(page.locator(".toast.error")).toContainText("Invalid JSON");
  await f.locator("[data-field=blob] textarea").fill('{"ok": true}');
  await f.locator("[data-field=blob] textarea").blur();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const after = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${guid}`);
  expect(after.data.fields.flag).toBe(false);
  expect(after.data.fields.count).toBeUndefined();
  expect(after.data.fields.one).toBeUndefined();
  expect(after.data.fields.ref).toBeUndefined();
  expect(after.data.fields.blob).toEqual({ ok: true });
  // the reference chip links to the target
  await page.locator("[data-field=refs] .ref-chip a").click();
  await expect(page.locator("corestone-detail h2")).toHaveText(target.title);
});

test("attachments: upload, list, use in an attachment field, open, delete", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "all", title: "With files" });
  await page.goto(`/artifact/${e.meta.guid}`);
  await page.locator(".quicklinks a", { hasText: "Attachments" }).click();
  await expect(page.locator("#sec-attachments")).toContainText("Files stored in");
  await page.locator("#sec-attachments input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachment") });
  await expect(page.locator(".toast.success")).toContainText("Attached notes.txt");
  const row = page.locator("#sec-attachments .attach-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("notes.txt");
  await expect(row.locator(".size")).toContainText("B");
  const href = await row.locator("a").getAttribute("href");
  const res = await fetch(base(href!));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello attachment");
  // the attachment field offers the file
  await page.locator("[data-field=file] select").selectOption("notes.txt");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${e.meta.guid}`);
  expect(stored.data.fields.file).toBe("notes.txt");
  // history recorded the attachment commit
  await expect(page.locator("#sec-history .history-row", { hasText: "Attachment notes.txt" })).toHaveCount(1);
  // delete it: the field now shows it as missing
  await row.locator("button").click();
  await expect(page.locator("#sec-attachments .attach-row")).toHaveCount(0);
  await expect(page.locator("[data-field=file] select option[selected]")).toContainText("missing");
  const after = await get<{ attachments: unknown[] }>(`/entries/${e.meta.guid}`);
  expect(after.attachments ?? []).toEqual([]);
});

function base(href: string) {
  return href.startsWith("http") ? href : api.replace(/\/api$/, "") + href;
}

test("an artifact without a schema is still editable", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "mystery", title: "No schema", fields: { anything: "goes", n: 3, deep: { a: 1 } } });
  await page.goto(`/artifact/${e.meta.guid}`);
  await expect(page.locator("#sec-general")).toContainText("no schema");
  await expect(page.locator("[data-field=anything] input")).toHaveValue("goes");
  await expect(page.locator("[data-field=deep] textarea")).toHaveValue(/"a"/);
  await page.locator("[data-field=anything] input").fill("changed");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${e.meta.guid}`);
  expect(stored.data.fields).toMatchObject({ anything: "changed", n: 3, deep: { a: 1 } });
  await expect(page.locator("#sec-workflows")).toHaveCount(0);
});
