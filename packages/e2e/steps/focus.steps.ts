import { expect, type Page } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

async function clickFocus(page: Page) {
  // On a phone the tab strip sits behind the switcher.
  if (await page.getByTestId("focus-tab").isVisible()) await page.getByTestId("focus-tab").click();
  else {
    await page.getByTestId("tab-switcher").click();
    await page.getByRole("option", { name: /^Focus/ }).click();
  }
}

When("I open Focus", async ({ page }) => {
  await clickFocus(page);
  await expect(page.getByTestId("focus-page")).toBeVisible();
});

// A maximized bottom panel stays maximized on Focus (GH-367): the page sits behind it.
When("I switch to Focus", async ({ page }) => {
  await clickFocus(page);
  await expect(page.getByTestId("focus-tab")).toHaveAttribute("data-active", "true");
});

When("I select the {word} request in Focus", async ({ page }, kind: string) => {
  // The worker's daemon is shared by scenarios: an earlier scenario's session may still wait, so pick by kind.
  const row = page.locator(`[data-testid="focus-row"][data-kind="${kind}"]`).first();
  await expect(row).toBeVisible({ timeout: TURN_MS });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
});

Then("the Focus waiting line shows only the wait time", async ({ page }) => {
  const line = page.getByTestId("focus-detail").getByTestId("focus-waiting");
  await expect(line).toHaveCount(1);
  await expect(line).toHaveText(/^\s*waiting (\d+m )?\d+s\s*$/);
});

/** The detail pane text without the session title and recent context: both echo the user's own prompt; the request must not repeat outside its card. */
async function detailText(page: Page): Promise<string> {
  return page.getByTestId("focus-detail").evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-testid="focus-context"], [data-testid="focus-title"]').forEach((n) => n.remove());
    return copy.textContent ?? "";
  });
}

const occurrences = (body: string, text: string) => body.split(text).length - 1;

Then("the Focus detail shows {string} once", async ({ page }, text: string) => {
  expect(occurrences(await detailText(page), text)).toBe(1);
});

Then("the Focus detail shows the question text once", async ({ page }) => {
  const question = (await page.getByTestId("focus-detail").getByTestId("question-panel").locator("legend").innerText()).trim();
  expect(question.length).toBeGreaterThan(0);
  expect(occurrences(await detailText(page), question)).toBe(1);
});

Then("the Focus detail has a Permission card", async ({ page }) => {
  await expect(page.getByTestId("focus-detail").getByTestId("permission-panel")).toHaveCount(1);
});

Then("the Focus detail has a Question card", async ({ page }) => {
  await expect(page.getByTestId("focus-detail").getByTestId("question-panel")).toHaveCount(1);
});

Then("the Focus row for the request shows {string}", async ({ page }, text: string) => {
  await expect(page.locator('[data-testid="focus-row"][aria-current="true"]')).toContainText(text);
});
