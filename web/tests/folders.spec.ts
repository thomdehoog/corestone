import { answerPrompt, expect, get, post, seedDomain, stamp, test } from "./fixtures";

// Folders exist only through their content: the folder field marks the
// segments a write would create, warns about near-misses of an existing
// sibling, offers the hierarchy to pick from, and "New folder" plans a
// destination that becomes real with its first artifact.

const id = stamp();
const folder = `fold-${id}`;

test.beforeAll(async () => {
  await seedDomain(folder, "F" + id.slice(-3).toUpperCase());
  await post("/entries", { path: `${folder}/specs`, type: "req", title: `Seed ${id}`, fields: { priority: "low" } });
});

async function openNewReq(page: import("@playwright/test").Page) {
  await page.keyboard.press("n");
  await page.locator(".dialog .type-card[data-type=req]").click();
  await page.locator("#new-title").waitFor();
}

test("the folder field marks new segments, catches typos and browses the tree", async ({ page }) => {
  await page.goto(`/folder/${folder}/specs`);
  await page.locator("table.grid tbody tr").first().waitFor();
  await openNewReq(page);
  const input = page.locator("#new-path");
  await expect(input).toHaveValue(`${folder}/specs`);
  await expect(page.locator("[data-test=folder-status]")).toHaveCount(0);

  await input.fill(`${folder}/specs/boot/deep`);
  await expect(page.locator("[data-test=folder-status] .folder-path .new")).toHaveText(["boot", "deep"]);
  await expect(page.locator("[data-test=folder-typo]")).toHaveCount(0);

  await input.fill(`${folder}/spec/boot`);
  await expect(page.locator("[data-test=folder-typo]")).toContainText("specs");
  await page.locator("[data-test=folder-typo] button").click();
  await expect(input).toHaveValue(`${folder}/specs/boot`);
  await expect(page.locator("[data-test=folder-status] .folder-path .new")).toHaveText(["boot"]);

  await page.locator("[data-test=folder-browse]").click();
  await page.locator(`.folder-browser .row[data-pick="${folder}"] .caret`).click();
  await page.locator(`.folder-browser .row[data-pick="${folder}/specs"]`).click();
  await expect(input).toHaveValue(`${folder}/specs`);
  await expect(page.locator("[data-test=folder-status]")).toHaveCount(0);

  await input.fill(`${folder}/specs/boot`);
  await page.locator("#new-title").fill(`Booted ${id}`);
  await page.locator(".dialog select").first().selectOption("high");
  await page.locator(".dialog button[type=submit]").click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Booted ${id}`);
  const tree = await get<{ folders: { name: string }[] }>(`/repository/tree?path=${folder}/specs`);
  expect(tree.folders.map((f) => f.name)).toContain("boot");
});

test("New folder plans a destination that becomes real with its first artifact", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator(`.tree .row[data-folder="${folder}/specs"]`).waitFor();
  await page.locator("[data-test=new-folder]").click();
  await answerPrompt(page, "plans");
  const row = page.locator(`.tree .row[data-folder="${folder}/plans"]`);
  await expect(row).toHaveClass(/pending/);
  await expect(page.locator(".toolbar .title")).toHaveText("plans");

  await openNewReq(page);
  await expect(page.locator("#new-path")).toHaveValue(`${folder}/plans`);
  await expect(page.locator("[data-test=folder-status] .folder-path .new")).toHaveText(["plans"]);
  await page.locator("#new-title").fill(`Planned ${id}`);
  await page.locator(".dialog select").first().selectOption("high");
  await page.locator(".dialog button[type=submit]").click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Planned ${id}`);
  await expect(row).not.toHaveClass(/pending/);
});

test("moving a folder uses the folder field and does not flag the rename as a typo", async ({ page }) => {
  await post("/entries", { path: `${folder}/moveme`, type: "req", title: `Mover ${id}`, fields: { priority: "low" } });
  await page.goto(`/folder/${folder}/moveme`);
  await page.locator("[data-test=move-folder]").click();
  const input = page.locator(".dialog input[data-test=prompt]");
  await input.fill(`${folder}/moveme2`);
  await expect(page.locator("[data-test=folder-status] .folder-path .new")).toHaveText(["moveme2"]);
  await expect(page.locator("[data-test=folder-typo]")).toHaveCount(0);
  await input.press("Enter");
  await expect(page.locator(".toolbar .title")).toHaveText("moveme2");
});

test("the navigation is rooted at the current folder, with an up row and a filter for wide levels", async ({ page }) => {
  const wide = `${folder}/wide`;
  for (let i = 0; i < 17; i++) await post("/entries", { path: `${wide}/part-${String(i).padStart(2, "0")}/sub`, type: "req", title: `W${i} ${id}`, fields: { priority: "low" } });
  await page.goto(`/folder/${folder}`);
  const rows = page.locator("corestone-sidebar ul.tree").first().locator(".row");
  await expect(rows.first()).toHaveAttribute("data-folder", folder);
  await expect(page.locator("[data-test=nav-up]")).toHaveText(/Repository/);
  await expect(page.locator("[data-test=folder-filter]")).toHaveCount(0);

  // clicking a folder makes it the top of the tree; siblings and ancestors are gone
  await page.locator(`.tree .row[data-folder="${wide}"]`).click();
  await expect(rows.first()).toHaveAttribute("data-folder", wide);
  await expect(page.locator(`.tree .row[data-folder="${folder}/specs"]`)).toHaveCount(0);
  await expect(page.locator(`.tree .row[data-folder^="${wide}/part-"]`)).toHaveCount(17);

  // the filter narrows a wide level
  await page.locator("[data-test=folder-filter]").fill("part-1");
  await expect(page.locator(`.tree .row[data-folder^="${wide}/part-"]`)).toHaveCount(7);

  // a caret expands in place without navigating
  await page.locator(`.tree .row[data-folder="${wide}/part-12"] .caret`).click();
  await expect(page.locator(`.tree .row[data-folder="${wide}/part-12/sub"]`)).toBeVisible();
  await expect(page.locator(".toolbar .title")).toHaveText("wide");

  // up returns to the parent, which becomes the top again
  await page.locator("[data-test=nav-up]").click();
  await expect(rows.first()).toHaveAttribute("data-folder", folder);
  await expect(page.locator(`.tree .row[data-folder="${folder}/specs"]`)).toBeVisible();
  await page.locator("[data-test=nav-up]").click();
  await expect(page.locator("[data-test=nav-up]")).toHaveCount(0);
});

test("the New dialog follows the typed folder's schema scope", async ({ page }) => {
  // a type that exists only below this test's folder
  await page.goto(`/folder/${folder}/specs`);
  await page.locator("table.grid tbody tr").first().waitFor();
  await openNewReq(page);
  const input = page.locator("#new-path");
  await expect(input).toHaveValue(`${folder}/specs`);
  await expect(page.locator("[data-test=scope-notice]")).toHaveCount(0);
  await expect(page.locator("[data-test=create]")).toBeEnabled();

  // outside the scope: the type is not defined there, and the save is held back
  await input.fill(`${folder}-elsewhere/x`);
  await expect(page.locator("[data-test=scope-notice]")).toContainText("not defined");
  await expect(page.locator("[data-test=create]")).toBeDisabled();

  // back inside: the notice goes and the form is usable again
  await input.fill(`${folder}/specs/deeper`);
  await expect(page.locator("[data-test=scope-notice]")).toHaveCount(0);
  await expect(page.locator("[data-test=create]")).toBeEnabled();
  await page.locator("#new-title").fill(`Deeper ${id}`);
  await page.locator(".dialog select").first().selectOption("high");
  await page.locator("[data-test=create]").click();
  await expect(page.locator("corestone-detail h2")).toHaveText(`Deeper ${id}`);
});

test("the overview says when subfolders hold more than the folder itself", async ({ page }) => {
  const nest = `${folder}/nest`;
  await post("/entries", { path: nest, type: "req", title: `Nest top ${id}`, fields: { priority: "low" } });
  for (const sub of ["a", "b", "b/c"]) await post("/entries", { path: `${nest}/${sub}`, type: "req", title: `Nest ${sub} ${id}`, fields: { priority: "low" } });
  await page.goto(`/folder/${nest}`);
  await expect(page.locator(".toolbar .hint")).toContainText("1 artifact here");
  await expect(page.locator("[data-test=show-subtree]")).toHaveText("4 incl. subfolders");
  // the tree count is the subtree count, and its tooltip says how it splits
  await page.locator("[data-test=nav-up]").click();
  const count = page.locator(`.tree .row[data-folder="${nest}"] .count`);
  await expect(count).toHaveText("4");
  await expect(count).toHaveAttribute("title", "1 artifact here, 3 artifacts in subfolders");
  // the link turns the subtree view on
  await page.locator(`.tree .row[data-folder="${nest}"]`).click();
  await page.locator("[data-test=show-subtree]").click();
  await expect(page.locator("[data-test=subtree]")).toBeChecked();
  await expect(page.locator(".toolbar .hint")).toContainText("4 artifacts incl. subfolders");
  await expect(page.locator("[data-test=show-subtree]")).toHaveCount(0);
});
