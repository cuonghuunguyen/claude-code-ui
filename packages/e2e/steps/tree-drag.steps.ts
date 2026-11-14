import { expect, type Locator, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";
import { endsWithPath } from "../support/css.ts";
import { promptBox } from "../support/ui.ts";

const row = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"]${endsWithPath("data-path", rel)}`).first();

// Rows are picked like a user does: Ctrl (Cmd on macOS) held while clicking.
When("I ControlOrMeta-click the tree row {string}", async ({ page }, rel: string) => {
  await row(page, rel).click({ modifiers: ["ControlOrMeta"] });
});

Then("the tree row {string} is selected", async ({ page }, rel: string) => {
  await expect(row(page, rel)).toHaveAttribute("aria-selected", "true");
});

Then("the tree row {string} is not selected", async ({ page }, rel: string) => {
  await expect(row(page, rel)).not.toHaveAttribute("aria-selected", "true");
});

// The pane's own area above the prompt box: the timeline, empty space included.
When("I drag the tree row {string} onto the timeline", async ({ page }, rel: string) => {
  const b = (await page.getByTestId("session-area").boundingBox())!;
  const [x, y] = [b.x + b.width / 2, b.y + b.height * 0.4];
  await row(page, rel).hover();
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.move(x + 2, y, { steps: 2 });
  await page.mouse.up();
});

Then("the prompt box text is {string}", async ({ page }, text: string) => {
  await expect.poll(() => promptBox(page).inputValue()).toBe(text);
});

Then("the prompt box has no drop ring", async ({ page }) => {
  await expect(page.getByTestId("prompt-box")).not.toHaveClass(/(^| )ring-ring( |$)/);
});
