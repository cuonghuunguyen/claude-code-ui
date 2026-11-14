import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { TURN_MS, openSettings } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

// GH-718: a fork subagent and its card (docs/spec.md "Fork runs"). Structure only, never the reply wording.
// The run card is shared with inline tasks; a fork card is the run card labelled "Fork".

const card = (page: Page): Locator => page.getByTestId("run-card").filter({ hasText: "Fork" }).first();
const header = (page: Page): Locator => card(page).locator("button[aria-expanded]").first();
const STATUS: Record<string, string> = { running: "running", finished: "done", stopped: "stopped", failed: "error" };

async function opened(page: Page): Promise<Locator> {
  await expect(card(page)).toBeVisible({ timeout: TURN_MS });
  if ((await header(page).getAttribute("aria-expanded")) === "false") await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-expanded", "true");
  return card(page);
}

Given("the scratch project has the fork fixtures", async ({ project }) => {
  for (const [name, word] of [["one.txt", "alpha"], ["two.txt", "bravo"], ["three.txt", "charlie"]] as const) {
    const file = join(project.path, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${word}\n`);
  }
});

When("I set fork subagents to {word} in Settings", async ({ page }, state: string) => {
  await openSettings(page);
  await page.getByTestId("settings-group-fork").click();
  const toggle = page.getByTestId("settings-fork-enabled");
  await expect(toggle).toBeVisible();
  const on = state === "on";
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  await page.waitForTimeout(600); // the save round trip to the daemon
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

Then("the fork card is {word}", async ({ page }, outcome: string) => {
  const status = STATUS[outcome];
  if (!status) throw new Error(`unknown outcome "${outcome}"; use one of ${Object.keys(STATUS).join(", ")}`);
  await expect(card(page)).toHaveAttribute("data-status", status, { timeout: 2 * TURN_MS });
});

Then("exactly one fork card is shown", async ({ page }) => {
  await expect(card(page)).toBeVisible({ timeout: TURN_MS });
  await expect(page.getByTestId("run-card").filter({ hasText: "Fork" })).toHaveCount(1);
});

Then("no plain subagent card is shown", async ({ page }) => {
  await expect(page.getByTestId("subagent")).toHaveCount(0);
});

// With the setting off the CLI has no fork type: a call for one is rejected (an errored card), never a run that finished.
Then("no fork run has finished", async ({ page }) => {
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("run-card").filter({ hasText: "Fork" }).and(page.locator('[data-status="done"]'))).toHaveCount(0);
});

Then("the fork card shows collapsed", async ({ page }) => {
  await expect(card(page)).toBeVisible({ timeout: TURN_MS });
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");
  await expect(card(page).getByTestId("run-result")).toBeHidden();
});

Then("the fork card shows its result", async ({ page }) => {
  const c = await opened(page);
  await expect(c.getByTestId("run-result")).toHaveText(/\S/, { timeout: TURN_MS });
  await expect(c.getByTestId("run-result")).toHaveCount(1);
});

Then("the fork card steps are collapsed", async ({ page }) => {
  const c = await opened(page);
  const toggle = c.getByTestId("run-steps-toggle");
  await expect(toggle).toBeVisible({ timeout: TURN_MS });
  await expect(toggle).toHaveText(/\d/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(c.getByTestId("tool-card")).toHaveCount(0);
});

When("I open the fork card steps", async ({ page }) => {
  const c = await opened(page);
  const toggle = c.getByTestId("run-steps-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

Then("the fork card steps show a {string} step", async ({ page }, tool: string) => {
  const c = await opened(page);
  // Reads and searches are folded into an "Explored" group.
  const found = c.getByTestId("tool-card").filter({ hasText: tool }).first().or(c.getByRole("button", { name: /Explored/ }).first());
  await expect(found).toBeVisible({ timeout: TURN_MS });
});
