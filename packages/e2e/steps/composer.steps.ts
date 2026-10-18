import { expect } from "@playwright/test";
import { sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

When("I send {string}", async ({ page }, text: string) => {
  await sendPrompt(page, text);
});

When("I stop the turn", async ({ page }) => {
  await page.getByTestId("toolbar-stop").click();
});

Then("I see my prompt in the transcript", async ({ page }) => {
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])').first()).toBeVisible({ timeout: TURN_MS });
});

Then("I see a reply from Claude", async ({ page }) => {
  // Structure only: a reply block with some text, never its wording.
  await expect(page.getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the turn has finished", async ({ page }) => {
  await waitTurnEnd(page);
});
