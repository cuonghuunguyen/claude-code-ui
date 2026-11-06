import { expect, type Locator, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const timeline = (page: Page): Locator => page.getByTestId("timeline");
const rows = (page: Page): Locator => timeline(page).getByTestId("timeline-row");

/** The Timeline sits under the tree: in a narrow Files panel that is the drawer, which a file open folds away. */
When("I open the Timeline", async ({ page }) => {
  const toggle = page.getByTestId("toggle-timeline");
  if (!(await toggle.isVisible())) await page.getByTestId("toggle-tree").click();
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(timeline(page).locator("#timeline-list")).toBeVisible();
});

When("I close the file tree drawer", async ({ page }) => {
  if (await page.getByTestId("file-tree-drawer").isVisible()) await page.getByTestId("toggle-tree").click();
  await expect(page.getByTestId("file-tree-drawer")).toBeHidden();
});

Then("the Timeline lists {string}", async ({ page }, titles: string) => {
  const want = titles.split(",").map((t) => t.trim());
  await expect(rows(page).getByTestId("timeline-title")).toHaveText(want, { timeout: 30_000 });
});

When("I hide Git history in the Timeline", async ({ page }) => {
  await timeline(page).getByTestId("timeline-filter").click();
  await page.getByTestId("timeline-filter-git").click();
  await page.keyboard.press("Escape");
  await expect(timeline(page).locator('[data-source="git"]')).toHaveCount(0);
});

When("I choose {string} in the menu of the Timeline row {string}", async ({ page }, item: string, title: string) => {
  await rows(page).filter({ hasText: title }).first().getByTestId("timeline-row-menu").click();
  await page.getByRole("menuitem", { name: item, exact: true }).click();
});

Then("the comparison dialog is shown", async ({ page }) => {
  await expect(page.getByTestId("viewer-dialog")).toHaveAttribute("data-kind", "compare");
  await expect(page.getByTestId("compare-diff")).toBeVisible();
});

When("I close the comparison dialog", async ({ page }) => {
  await page.getByTestId("viewer-close").click();
  await expect(page.getByTestId("viewer-dialog")).toBeHidden();
});

// The restore reaches the open editor through the file watch.
Then("the Files editor text is {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("files-panel").locator(".cm-content").first()).toHaveText(text, { timeout: 30_000 });
});

Then("every Timeline row is at least 44px high", async ({ page }) => {
  const heights = await rows(page).evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
});
