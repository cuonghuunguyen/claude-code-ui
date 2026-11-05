import { expect, type Locator, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const gutter = (page: Page): Locator => page.getByTestId("files-panel").locator(".cm-blame");
const marks = (page: Page): Locator => gutter(page).locator(".cm-blame-mark");

// A new line before the committed one: it is not committed, the old line keeps its commit.
When("I type a new first line in the Files editor", async ({ page }) => {
  await page.getByTestId("files-panel").locator(".cm-content").first().click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("// note");
  await page.keyboard.press("Enter");
});

When("I turn on Annotate", async ({ page }) => {
  const toggle = page.getByTestId("editor-annotate");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

Then("the Annotate gutter shows a short hash", async ({ page }) => {
  await expect(marks(page).filter({ hasText: /^[0-9a-f]{7} / }).first()).toBeVisible({ timeout: 30_000 });
});

Then("the Annotate gutter shows {string}", async ({ page }, text: string) => {
  await expect(marks(page).filter({ hasText: text }).first()).toBeVisible();
});

When("I click the first Annotate entry", async ({ page }) => {
  await marks(page).filter({ hasText: /^[0-9a-f]{7} / }).first().click();
});

Then("the Git graph shows the selected commit {string}", async ({ page }, subject: string) => {
  await expect(page.getByTestId("graph-filter-text")).toHaveValue(/^[0-9a-f]{40}$/, { timeout: 30_000 });
  await expect(page.getByTestId("commit-details")).toContainText(subject, { timeout: 30_000 });
});

Then("the Annotate button is at least 44px high", async ({ page }) => {
  const box = await page.getByTestId("editor-annotate").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

// Real Tab presses from the toggle: the marker must be a tab stop with its aria-label.
When("I Tab from Annotate to the first commit marker", async ({ page }) => {
  const marker = marks(page).filter({ hasText: /^[0-9a-f]{7} / }).first();
  await expect(marker).toHaveAttribute("aria-label", /^Commit [0-9a-f]{7} by .+, /);
  await page.getByTestId("editor-annotate").focus();
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    if (await marker.evaluate((e) => e === document.activeElement)) return;
  }
  throw new Error("Tab never reached the first commit marker");
});
