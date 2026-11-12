import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { idleSend, TURN_MS, waitConnected } from "../support/ui.ts";
import { ownDaemon } from "./opencode-engine.steps.ts";
import { Given, Then, When } from "./fixtures.ts";

const agent = (page: Page) => page.getByTestId("agent-select");
const mode = (page: Page) => page.getByTestId("mode-select");
/** A phone keeps agent, mode and model behind one button: opens it (only when its popup is not open yet). */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if ((await s.isVisible()) && !(await page.getByTestId("session-settings-popup").isVisible())) await s.click();
};
const optionNames = async (page: Page) => (await page.getByRole("listbox").getByRole("option").allTextContents()).map((s) => s.trim());

Given("the OpenCode project has a primary agent {string} that cannot edit", async ({ project }, name: string) => {
  // Written before the project is opened (OpenCode keeps a folder's config once it has loaded it). No $schema: OpenCode would fetch it and stall offline.
  const cfg = { agent: { [name]: { description: "Reviews code, never edits", mode: "primary", permission: { edit: "deny", bash: "ask" } } } };
  writeFileSync(join(project.path, "opencode.json"), JSON.stringify(cfg));
});

// Merged into an existing opencode.json; written before the project opens, like the agent above.
Given("the OpenCode project config sets the permission {string} to {string}", async ({ project }, key: string, action: string) => {
  const file = join(project.path, "opencode.json");
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...cfg, permission: { ...cfg.permission, [key]: action } }));
});

When("I open the agent chooser", async ({ page }) => {
  await settingsOpen(page);
  await expect(agent(page)).toBeVisible({ timeout: 30_000 });
  await agent(page).click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the agent chooser offers exactly {string}", async ({ page }, list: string) => {
  const want = list.split(", ");
  // The list may still be loading on a cold start (the chooser shows the current agent meanwhile): poll, no fixed wait.
  await expect.poll(async () => (await optionNames(page)).map((n) => n.split(/\s/)[0]), { timeout: 30_000 }).toEqual(want);
});

Then("the agent chooser comes before the permission chooser", async ({ page }) => {
  const [a, m] = [await agent(page).boundingBox(), await mode(page).boundingBox()];
  expect(a && m).toBeTruthy();
  expect(a!.x).toBeLessThan(m!.x);
});

When("I open the permission chooser", async ({ page }) => {
  await settingsOpen(page);
  await expect(mode(page)).toBeVisible({ timeout: 30_000 });
  await mode(page).click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the permission chooser offers exactly {string}", async ({ page }, list: string) => {
  // The engine chooser may still fade out with its own options.
  await expect.poll(() => optionNames(page)).toEqual(list.split(", "));
});

When("I pick the agent {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await expect(agent(page)).toBeVisible({ timeout: 30_000 });
  await agent(page).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(agent(page)).toContainText(name);
});

When("I pick the permission mode {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await mode(page).click();
  await page.getByRole("option", { name }).click();
  await expect(mode(page)).toHaveAttribute("aria-label", /Permission mode/);
  await expect(mode(page)).toContainText(name);
});

Then("the agent chooser shows {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await expect(agent(page)).toContainText(name, { timeout: 30_000 });
});

When("I restart the OpenCode daemon", async ({ page }) => {
  const lost = expect(page.getByTestId("connection-status").first()).not.toHaveText(/^\s*connected\s*$/, { timeout: 60_000 });
  const [restarted, seen] = await Promise.allSettled([ownDaemon()!.restart(), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
  await waitConnected(page);
});

When("I open the agent and permission choosers", async ({ page }) => {
  await settingsOpen(page);
});

Then("both choosers are visible", async ({ page }) => {
  await expect(agent(page)).toBeVisible({ timeout: 30_000 });
  await expect(mode(page)).toBeVisible();
});

Then("each chooser is at least 44px tall on a phone", async ({ page, $testInfo }) => {
  if (!(await page.getByTestId("session-settings").isVisible())) return void $testInfo.annotations.push({ type: "desktop", description: "no phone settings button at this width" });
  // The settings popup scales in from 95%: measure once it has settled.
  for (const c of [agent(page), mode(page)]) await expect.poll(async () => (await c.boundingBox())?.height ?? 0, { timeout: 3000 }).toBeGreaterThanOrEqual(44);
});

Then("there is no agent chooser", async ({ page }) => {
  await expect(mode(page)).toBeVisible();
  await expect(agent(page)).toHaveCount(0);
});

// The agent's edit denial removes the write tools: the model either gets a denied tool card or cannot call a write tool at all. Both are a refusal; a completed card is not.
Then("no {string} tool call completed", async ({ page }, text: string) => {
  await expect(page.getByTestId("tool-card").filter({ hasText: text }).and(page.locator('[data-status="done"]'))).toHaveCount(0);
});

Then("the transcript shows the model's reply", async ({ page }) => {
  await expect(page.getByTestId("assistant-text").first()).toBeVisible();
});

// The model may fall back to Bash when the agent has no write tool: its permission question is answered by denying it, until the turn ends.
When("I deny every permission request until the turn has finished", async ({ page }) => {
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])').first()).toBeVisible({ timeout: TURN_MS });
  const deny = page.getByTestId("permission-panel").getByRole("button", { name: "Deny" });
  const idle = idleSend(page);
  const end = Date.now() + TURN_MS;
  while (!(await idle.isVisible())) {
    if (Date.now() > end) throw new Error("the turn did not finish");
    await Promise.race([idle.waitFor({ timeout: 10_000 }), deny.waitFor({ timeout: 10_000 })]).catch(() => undefined);
    // The panel may be replaced by the next request or removed while it animates in: the loop retries.
    if (await deny.isVisible()) await deny.click({ timeout: 5000 }).catch(() => undefined);
  }
});

Then("the permission mode is still {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await expect(mode(page)).toContainText(name);
});
