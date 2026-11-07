import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const panel = (page: Page) => page.getByTestId("permission-panel");
/** A phone keeps mode, model and effort behind one button: opens it (the popup closes with Escape). */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if (await s.isVisible()) await s.click();
};
const userMessage = (page: Page) => page.getByTestId("user-message").first();
const rewind = (page: Page) => userMessage(page).getByRole("button", { name: "Rewind to before this message" });

Given("the project has a file {string} with the text {string}", async ({ project }, name: string, text: string) => {
  writeFileSync(join(project.path, name), text);
});

Then("the permission panel has no Edit content button", async ({ page }) => {
  await expect(panel(page).getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /Edit content/ })).toHaveCount(0);
});

When("I allow the permission request always", async ({ page }) => {
  await panel(page).getByRole("button", { name: "Allow always" }).click({ timeout: TURN_MS });
});

Then("the permission rule line shows {string}", async ({ page }, rule: string) => {
  await expect(page.getByTestId("permission-rules")).toContainText(rule);
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

Then("the question is answered", async ({ page }) => {
  await expect(page.getByTestId("question-panel")).toBeHidden({ timeout: TURN_MS });
  await expect(page.getByTestId("question-marker").first()).toHaveAttribute("data-settled", "true");
});

Then("the transcript shows the interrupted divider", async ({ page }) => {
  await expect(page.getByTestId("turn-interrupted")).toBeVisible();
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

When("I pick the first model of the group {string}", async ({ page }, group: string) => {
  const opts = page.getByRole("group").filter({ hasText: group }).getByRole("option");
  const item = opts.first();
  const name = (await item.textContent())!.trim();
  await item.click();
  await expect(page.getByTestId("session-model")).toHaveAttribute("title", new RegExp(name.slice(0, 8)));
  await page.keyboard.press("Escape");
});

When("I open the mode chooser", async ({ page }) => {
  await settingsOpen(page);
  await page.getByTestId("mode-select").click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the mode chooser offers exactly {string}", async ({ page }, list: string) => {
  const names = (await page.getByRole("option").allTextContents()).map((s) => s.trim());
  expect(names).toEqual(list.split(", "));
});

Then("the effort chooser is absent", async ({ page }) => {
  await expect(page.getByTestId("effort-select")).toHaveCount(0);
});

Then("the rewind button is disabled", async ({ page }) => {
  await userMessage(page).hover();
  await expect(rewind(page)).toHaveAttribute("aria-disabled", "true");
});

When("I click the rewind button", async ({ page }) => {
  await userMessage(page).hover();
  await rewind(page).click({ force: true }); // aria-disabled, not disabled: the click opens the reason
  await rewind(page).hover(); // the tooltip closes after a click; hovering keeps it open for the capture
});

Then("the unsupported reason shows", async ({ page }) => {
  await expect(page.getByTestId("engine-unsupported")).toBeVisible();
});

Then("the palette row {string} is disabled with a reason", async ({ page }, title: string) => {
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill(title);
  const row = palette.getByRole("option", { name: new RegExp(title, "i") }).first();
  await expect(row).toHaveAttribute("aria-disabled", "true");
  await expect(row).toContainText("Not supported by this session's engine");
});

Then("a subagent card is shown", async ({ page }) => {
  await expect(page.getByTestId("subagent").first()).toBeVisible({ timeout: TURN_MS });
});

When("the reply has started streaming", async ({ page }) => {
  await expect(page.getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: TURN_MS });
});
