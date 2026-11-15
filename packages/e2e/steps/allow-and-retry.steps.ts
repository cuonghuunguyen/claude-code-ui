import { expect, type Page } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Then } from "./fixtures.ts";

// Allow and retry (GH-711). Structure only: testids, the command and the card status, never reply wording.
const bashCards = (page: Page) => page.getByTestId("tool-card").filter({ hasText: /^Bash/ });

Then("the Bash tool card shows the auto mode denial {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("auto-mode-denial").first()).toContainText(text, { timeout: TURN_MS });
});

Then("a user message contains {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("user-message").filter({ hasText: text }).first()).toBeVisible({ timeout: TURN_MS });
});

Then("{int} Bash tool cards exist and the last one is done", async ({ page }, n: number) => {
  await expect(bashCards(page)).toHaveCount(n, { timeout: TURN_MS });
  await expect(bashCards(page).last()).toHaveAttribute("data-status", "done", { timeout: TURN_MS });
});
