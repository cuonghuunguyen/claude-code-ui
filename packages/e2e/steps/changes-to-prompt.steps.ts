import { expect, type Page } from "@playwright/test";
import { promptBox } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const diffBox = (page: Page) => page.getByTestId("changes-panel").getByTestId("file-diff");
// The line numbers sit in the library's shadow DOM; Playwright pierces it.
const gutter = (page: Page, type: "change-deletion" | "change-addition", n: number) =>
  diffBox(page).locator(`[data-line-type="${type}"][data-column-number="${n}"], [data-line-type="${type}"] [data-column-number="${n}"]`).first();

When("I select the diff lines from the removed line {int} to the added line {int}", async ({ page }, from: number, to: number) => {
  await gutter(page, "change-deletion", from).click();
  await gutter(page, "change-addition", to).click({ modifiers: ["Shift"] });
});

When("I press Alt+K in the diff", async ({ page }) => {
  await page.keyboard.press("Alt+K");
});

Then("the prompt box has the diff lines {string} and {string}", async ({ page }, a: string, b: string) => {
  await expect.poll(() => promptBox(page).inputValue()).toContain(a);
  expect(await promptBox(page).inputValue()).toContain(b);
  expect(await promptBox(page).inputValue()).toContain("```diff");
});

Then("the narrow diff header shows the file name and has no send button", async ({ page }) => {
  const header = page.getByTestId("changes-panel").getByTestId("file-diff-header");
  const name = await header.locator("span.truncate").boundingBox();
  expect(name!.width).toBeGreaterThan(40);
  await expect(header.getByTestId("diff-send-selection")).toHaveCount(0);
});
