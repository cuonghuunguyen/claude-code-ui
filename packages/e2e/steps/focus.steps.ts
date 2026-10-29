import { expect, type Page } from "@playwright/test";
import { TURN_MS, promptBox } from "../support/ui.ts";
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

// ---- GH-305: focus-rows.feature ----

const group = (page: Page) => page.getByTestId("focus-group").first();
const toggle = (page: Page) => group(page).getByTestId("focus-group-toggle").first();

Then("Focus shows a worker group with a permission row nested under its coordinator", async ({ page }) => {
  await expect(group(page)).toBeVisible({ timeout: TURN_MS });
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(group(page).getByTestId("focus-workers").locator('[data-testid="focus-row"][data-kind="permission"]').first()).toBeVisible({ timeout: TURN_MS });
});

When("I collapse the Focus worker group", async ({ page }) => {
  await toggle(page).click();
});

When("I expand the Focus worker group", async ({ page }) => {
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
});

Then("the Focus worker group is collapsed", async ({ page }) => {
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  await expect(group(page).getByTestId("focus-workers")).toHaveCount(0);
});

When("I enable Next for you in Settings", async ({ page }) => {
  await page.locator('[data-testid="open-settings"]:visible').first().click();
  await page.getByTestId("settings-group-focus").click();
  const switchEl = page.getByTestId("settings-focus-nextForYou");
  if ((await switchEl.getAttribute("aria-checked")) !== "true") await switchEl.click();
  await expect(switchEl).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

Then("a Finished row in Focus shows a Next for you chip", async ({ page }) => {
  // Timing-dependent: the CLI sends the suggestion a few seconds after the turn, and not always.
  await expect(page.getByTestId("focus-suggestion").first()).toBeVisible({ timeout: TURN_MS * 2 });
  await expect(page.getByTestId("focus-suggestion").first()).toContainText("Next for you");
});

When("I click the Next for you chip", async ({ page }) => {
  await page.getByTestId("focus-suggestion").first().click();
});

Then("the session opens with a prompt box that is not empty", async ({ page }) => {
  await expect(page.getByTestId("focus-page")).toBeHidden();
  await expect(promptBox(page)).toHaveValue(/\S/, { timeout: 15_000 });
});

Then("Focus shows a Finished row", async ({ page }) => {
  await expect(page.locator('[data-testid="focus-row"][data-kind="finished"]').first()).toBeVisible({ timeout: TURN_MS });
});
