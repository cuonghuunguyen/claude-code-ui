import { expect } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

// Always allow (GH-756). Structure only: testids, rule text and the card state, never reply wording.
When("I click Always allow", async ({ page }) => {
  await page.getByTestId("always-allow").first().click();
});

Then("the Always allow panel shows the rule {string}", async ({ page }, rule: string) => {
  await expect(page.getByTestId("always-allow-rule").first()).toHaveText(rule);
});

When("I pick the {string} scope in the Always allow panel", async ({ page }, scope: string) => {
  await page.getByTestId(`always-allow-${scope}`).first().click();
});

Then("the Always allow label shows {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("always-allowed").first()).toHaveText(text, { timeout: TURN_MS });
  await expect(page.getByTestId("always-allowed").first()).toBeDisabled();
});

Then("the Always allow scope buttons are at least 44px high", async ({ page }) => {
  for (const id of ["always-allow-session", "always-allow-local", "always-allow-cancel"]) {
    const box = await page.getByTestId(id).first().boundingBox();
    expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44);
  }
});

Then("the Always allow hint names a file ending {string}", async ({ page }, tail: string) => {
  await expect(page.getByTestId("always-allow-local-hint").first()).toHaveText(new RegExp(`^This project saves to /.*${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), { timeout: TURN_MS });
});
