import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

// Not a test of behaviour: captures screenshots of a seeded repository for
// the documentation. Run with SHOTS=1.
test("screenshots", async ({ page }) => {
  test.skip(!process.env.SHOTS, "set SHOTS=1 to capture");
  mkdirSync("shots", { recursive: true });
  await page.goto("/folder/specs?subtree=1");
  await page.waitForSelector("table.grid tbody tr");
  await page.locator("table.grid tbody tr", { hasText: "boots in under 2" }).first().click();
  await page.waitForSelector("corestone-detail .section");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "shots/overview-detail.png" });
  await page.goto("/folder/docs");
  await page.waitForSelector("table.grid tbody tr");
  await page.locator("table.grid tbody tr").first().click();
  await page.waitForSelector(".doc-page .entry-card");
  await page.locator("[data-test=sb-rel]").click();
  await page.locator("[data-test=sb-comments]").click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: "shots/document.png" });
  await page.goto("/folder/specs");
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-entry]").click();
  await page.waitForSelector(".type-card");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "shots/new-type.png" });
  await page.locator(".type-card[data-type=requirement]").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "shots/new-form.png" });
});
