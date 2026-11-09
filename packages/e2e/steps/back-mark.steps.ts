import { expect, type Page } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const panel = (page: Page) => page.locator("[data-back-panel]").first();
const markButton = (page: Page) => page.getByRole("button", { name: /^I'll be back: mark this reply/ }).last();

When("I mark the last reply with I'll be back", async ({ page }) => {
  await markButton(page).click();
  await expect(panel(page)).toBeVisible();
});

Then("the I'll be back panel has the brief rows", async ({ page }) => {
  // Structure only: the three labelled rows the session wrote, never their wording.
  await expect(panel(page).locator("dt")).toHaveText(["About", "Focus now", "Next"], { timeout: TURN_MS });
});

Then("the timeline has one collapsed brief row and no tagged prompt", async ({ page }) => {
  await expect(page.getByTestId("back-brief-row")).toHaveCount(1);
  await expect(page.getByTestId("back-brief-row").getByRole("button")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("claude-ui-brief")).toHaveCount(0);
});

Then("the marked button is named {string}", async ({ page }, name: string) => {
  await expect(page.getByRole("button", { name }).last()).toBeVisible();
});

When("I set the reminder {string} in the panel", async ({ page }, text: string) => {
  const input = panel(page).getByLabel("Remind me in");
  await input.fill(text);
  await input.press("Enter");
});

Then("the panel shows an interval error {string}", async ({ page }, text: string) => {
  await expect(panel(page).getByRole("alert")).toHaveText(text);
  await expect(panel(page).getByLabel("Remind me in")).toHaveAttribute("aria-invalid", "true");
});

Then("the panel shows {string}", async ({ page }, text: string) => {
  await expect(panel(page)).toContainText(text);
});

Then("Focus lists the mark under {string}", async ({ page }, heading: string) => {
  const list = page.getByTestId("focus-back-list");
  await expect(list.getByRole("heading")).toContainText(heading);
  await expect(list.getByTestId("focus-back-row").first()).toContainText("Reminds");
});

Then("the reminder card shows Open, Snooze 1m and Dismiss", async ({ page }) => {
  // The daemon ticks every 30 s and the interval is at least 1 m.
  const card = page.getByTestId("back-reminder-card");
  await expect(card).toBeVisible({ timeout: 150_000 });
  await expect(card.getByRole("button", { name: "Open" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Snooze 1 minute" })).toHaveText("Snooze 1m");
  await expect(card.getByRole("button", { name: "Dismiss reminder" })).toBeVisible();
});

When("I click Open on the reminder card", async ({ page }) => {
  await page.getByTestId("back-reminder-card").getByRole("button", { name: "Open" }).click();
});

Then("the I'll be back panel has the focus", async ({ page }) => {
  await expect(panel(page)).toBeFocused();
});

Then("the transcript still has {int} brief row", async ({ page }, n: number) => {
  await expect(page.getByTestId("back-brief-row")).toHaveCount(n);
});

When("I click Done in the panel", async ({ page }) => {
  await panel(page).getByRole("button", { name: "Done: remove this mark" }).click();
});

Then("no I'll be back panel is shown", async ({ page }) => {
  await expect(page.locator("[data-back-panel]")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Mark removed" })).toBeVisible();
});
