
import { expect, type Page } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const panel = (page: Page) => page.getByTestId("permission-panel");
/** A phone keeps mode, model and effort behind one button: opens it (the popup closes with Escape). */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if (await s.isVisible()) await s.click();
};
const userMessage = (page: Page) => page.getByTestId("user-message").first();
const rewind = (page: Page) => userMessage(page).getByRole("button", { name: "Rewind to before this message" });

Then("the permission panel has no Edit content button", async ({ page }) => {
  await expect(panel(page).getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Edit content/ })).toHaveCount(0);
});

When("I deny the permission request with the feedback {string}", async ({ page }, text: string) => {
  await panel(page).getByRole("textbox").fill(text);
  await panel(page).getByRole("button", { name: "Deny" }).click();
});

When("I answer the question with its first option", async ({ page }) => {
  const q = page.getByTestId("question-panel");
  await q.getByRole("radio").first().check();
  await q.getByRole("button", { name: /^(Submit|Next)$/ }).click();
});

When("I open the model chooser", async ({ page }) => {
  await settingsOpen(page);
  await page.getByTestId("session-model").click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the model chooser lists {string} and the group {string}", async ({ page }, first: string, group: string) => {
  await expect(page.getByRole("option", { name: new RegExp(`^${first}`) })).toBeVisible();
  await expect(page.getByText(group, { exact: true }).last()).toBeVisible();
});

When("I close the open chooser", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  // The phone's settings popup may still be open.
  await page.keyboard.press("Escape");
});

Then("the rewind button is enabled", async ({ page }) => {
  await userMessage(page).hover();
  await expect(rewind(page)).not.toHaveAttribute("aria-disabled", "true");
});

Then("the palette row {string} is enabled", async ({ page }, title: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill(title);
  const row = palette.getByRole("option", { name: new RegExp(title, "i") }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute("aria-disabled", "true");
  await expect(row).not.toContainText("Not supported by this session's engine");
  await page.keyboard.press("Escape");
});

Then("the inline task card is done", async ({ page }) => {
  await expect(page.getByTestId("run-card").last()).toHaveAttribute("data-status", "done", { timeout: TURN_MS });
});
