import { expect, type Locator, type Page } from "@playwright/test";
import { TURN_MS, idleSend } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

// GH-709: the session agent uses the terminals open in the Terminal panel (docs/spec.md "Agent terminal access").

const view = (page: Page) => page.locator('[data-testid="terminal-view"]:visible').first();

/** The cards of a tool call: the ToolSearch call that loads the tool names it in its input, so it is left out. */
const cardsOf = (page: Page, tool: string): Locator => page.getByTestId("tool-card").filter({ hasText: tool }).filter({ hasNotText: /ToolSearch/ });

/** The card of a terminal tool call, opened so its output is in the DOM. */
async function opened(page: Page, tool: string): Promise<Locator> {
  const card = cardsOf(page, tool).first();
  await expect(card).toBeVisible({ timeout: TURN_MS });
  const closed = card.locator("button[aria-expanded='false']").first();
  if (await closed.count()) await closed.click();
  return card;
}

When("I set terminal access to {word} in Settings", async ({ page }, state: string) => {
  const on = state === "on";
  await page.locator('[data-testid="open-settings"]:visible').first().click();
  await page.getByTestId("settings-group-terminalAccess").click();
  const toggle = page.getByTestId("settings-terminalAccess-enabled");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

When("I resize the viewport to {int}x{int}", async ({ page }, width: number, height: number) => {
  await page.setViewportSize({ width, height });
});

Then("the {string} tool card is finished with the output", async ({ page }, tool: string) => {
  const card = await opened(page, tool);
  await expect(card).toHaveAttribute("data-status", "done", { timeout: TURN_MS });
  await expect(card.getByTestId("terminal-result")).toBeVisible();
});

Then("the {string} tool card output shows {string}", async ({ page }, tool: string, text: string) => {
  const card = await opened(page, tool);
  await expect(card.getByTestId("terminal-result")).toContainText(text, { timeout: TURN_MS });
});

Then("the {string} tool card output does not show {string}", async ({ page }, tool: string, text: string) => {
  const card = await opened(page, tool);
  await expect(card.getByTestId("terminal-result")).toBeVisible({ timeout: TURN_MS });
  await expect(card.getByTestId("terminal-result")).not.toContainText(text);
});

Then("the {string} tool card says no terminal is open in this project", async ({ page }, tool: string) => {
  const card = await opened(page, tool);
  await expect(card.getByTestId("terminal-result")).toContainText("No terminal is open in this project", { timeout: TURN_MS });
});

Then("the terminal has nothing typed from {string}", async ({ page }, text: string) => {
  await page.waitForTimeout(1500); // a late write would land within the wait
  await expect(view(page).locator(".xterm-rows")).not.toContainText(text);
});

Then("no terminal tool card is shown", async ({ page }) => {
  await page.waitForTimeout(1000);
  await expect(cardsOf(page, "terminal_")).toHaveCount(0);
});

Then("the {string} tool call is {word} in the terminal", async ({ page }, tool: string, outcome: string) => {
  const status = { finished: "done", denied: "denied" }[outcome];
  if (!status) throw new Error(`unknown outcome "${outcome}"`);
  await expect(cardsOf(page, tool).first()).toHaveAttribute("data-status", status, { timeout: TURN_MS });
});

// A second session's tab keeps its own model chooser and prompt box in the DOM: these two steps talk to the new-session tab only.
When("I start a new Haiku session in the new session tab", async ({ page, project }) => {
  const tab = page.getByTestId("new-session-tab").last();
  await expect(tab).toBeVisible({ timeout: 60_000 });
  const chip = tab.getByTestId("project-chip");
  await expect(async () => {
    if ((await chip.textContent())?.includes(project.name)) return;
    try {
      await chip.click();
      await page.getByRole("option", { name: project.name }).click({ timeout: 2_000 });
      await expect(chip).toContainText(project.name, { timeout: 2_000 });
    } catch (e) {
      await page.keyboard.press("Escape");
      throw e;
    }
  }).toPass({ timeout: 60_000 });
  await tab.getByTestId("session-model").click();
  await page.getByRole("option", { name: "Haiku" }).click();
  await expect(tab.getByTestId("session-model")).toContainText("Haiku");
});

When("I send {string} in the new session tab", async ({ page }, text: string) => {
  const tab = page.getByTestId("new-session-tab").last();
  await tab.getByRole("combobox", { name: "First prompt" }).fill(text);
  await expect(tab.getByTestId("send")).toBeEnabled();
  await tab.getByTestId("send").click();
});

Then("the new session has finished its turn", async ({ page }) => {
  await expect(idleSend(page).last()).toBeVisible({ timeout: TURN_MS });
});
