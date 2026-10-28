import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { Given, Then, When } from "./fixtures.ts";

const preview = (page: Page): Locator => page.getByTestId("md-preview");
const table = (root: Locator): Locator => root.locator("[data-streamdown=table]");

Given("the scratch project has the Markdown file {string} with a table of {int} rows", async ({ project }, rel: string, rows: number) => {
  const body = Array.from({ length: rows }, (_, i) => `| r${i + 1} | value ${i + 1} |`).join("\n");
  const file = join(project.path, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Table\n\n| name | value |\n|---|---|\n${body}\n\nAfter the table.\n`);
});

When("I open the tree file {string}", async ({ page }, rel: string) => {
  const row = page.locator(`[data-testid="tree-entry"][data-path$="/${rel}"]`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId("file-path-header")).toBeVisible();
});

When("I choose the Markdown view {string}", async ({ page }, view: string) => {
  const button = page.getByTestId(`md-view-${view.toLowerCase()}`);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(preview(page)).toBeVisible();
});

Then("the Markdown preview shows all {int} table rows with no inner table scroll box", async ({ page }, rows: number) => {
  const pane = preview(page);
  const t = table(pane);
  await expect(t.locator("tbody tr")).toHaveCount(rows, { timeout: 30_000 });
  const stuck = await t.first().evaluate((el, root) => {
    const found: string[] = [];
    for (let n = el.parentElement; n && n !== root; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const capped = cs.maxHeight !== "none" && cs.maxHeight !== "";
      const clipsY = /auto|scroll|hidden/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
      if (capped || clipsY) found.push(`${n.tagName} maxHeight=${cs.maxHeight} overflowY=${cs.overflowY} ${n.clientHeight}/${n.scrollHeight}`);
    }
    return found;
  }, await pane.elementHandle());
  expect(stuck, "no table ancestor caps or clips the table").toEqual([]);
  const h = await t.first().evaluate((el) => ({ box: el.getBoundingClientRect().height, rows: el.querySelectorAll("tbody tr").length }));
  expect(h.box).toBeGreaterThan(rows * 20);
});

Then("the Markdown preview scrolls to the last table row", async ({ page }) => {
  const pane = preview(page);
  const m = await pane.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(m.scroll, "the preview pane is the scroller").toBeGreaterThan(m.client + 50);
  await pane.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const last = table(pane).locator("tbody tr").last();
  await expect(last).toBeInViewport();
  const [r, p] = [await last.boundingBox(), await pane.boundingBox()];
  expect(r!.y + r!.height).toBeLessThanOrEqual(p!.y + p!.height + 1);
  expect(r!.y).toBeGreaterThanOrEqual(p!.y - 1);
});

Then("the Markdown preview is beside the source editor", async ({ page }) => {
  const [e, p] = [await page.getByTestId("code-editor").boundingBox(), await preview(page).boundingBox()];
  expect(e).not.toBeNull();
  expect(p!.x).toBeGreaterThanOrEqual(e!.x + e!.width - 1);
});

Then("the last chat reply has a table with an inner max-height box that scrolls", async ({ page }) => {
  const t = table(page.locator("body")).last();
  await expect(t).toBeVisible({ timeout: 30_000 });
  const m = await t.evaluate((el) => {
    const box = el.parentElement!;
    return { max: getComputedStyle(box).maxHeight, client: box.clientHeight, scroll: box.scrollHeight, rows: el.querySelectorAll("tbody tr").length };
  });
  expect(m.rows).toBeGreaterThan(15);
  expect(m.max).toBe("300px");
  expect(m.scroll).toBeGreaterThan(m.client);
});
