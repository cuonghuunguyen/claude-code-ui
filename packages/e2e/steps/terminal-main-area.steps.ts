import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const tab = (page: Page) => page.locator('[data-testid="tab"][data-tab-id^="terminal:"]');
const body = (page: Page) => page.locator('[data-pane-tab-body^="terminal:"]');
const view = (page: Page) => page.locator('[data-testid="terminal-view"]:visible').first();
let title = "";
const focused = (page: Page) => page.evaluate(() => !!document.activeElement?.closest(".xterm"));

When("I type {string} in the terminal", async ({ page }, cmd: string) => {
  await expect(view(page).locator(".xterm")).toBeVisible({ timeout: 30_000 });
  await view(page).locator(".xterm").click();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await expect(view(page).locator(".xterm-rows")).toContainText(cmd.replace(/^echo /, ""), { timeout: 15_000 });
});

Then("the terminal shows {string}", async ({ page }, text: string) => {
  await expect(view(page).locator(".xterm-rows")).toContainText(text);
});

Then("the terminal shows {string} on a line of its own", async ({ page }, text: string) => {
  await expect(view(page).locator(".xterm-rows > div").filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) })).toHaveCount(1);
});

Then("the shell has the focus", async ({ page }) => {
  await expect.poll(() => focused(page)).toBe(true);
});

Then("the shell does not have the focus", async ({ page }) => {
  await page.waitForTimeout(1000); // a late focus would land within a second
  expect(await focused(page)).toBe(false);
});

Then("the Terminal tab is right of its session tab", async ({ page }) => {
  const ids = await page.locator('[data-testid="tab-strip"] [data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id") ?? ""));
  const at = ids.findIndex((i) => i.startsWith("terminal:"));
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe(ids[at]!.slice("terminal:".length));
});

Then("the bottom panel has no Terminal tab", async ({ page }) => {
  await expect(page.getByTestId("bottom-panel").getByTestId("pane-terminal")).toHaveCount(0);
});

Then("the bottom panel shows the terminal with one shell", async ({ page }) => {
  await expect(page.getByTestId("bottom-panel").getByTestId("terminal-panel")).toBeVisible();
  await expect(page.getByTestId("bottom-panel").getByTestId("terminal-tab")).toHaveCount(1);
});

Then("the Terminal tab has one shell", async ({ page }) => {
  await expect(body(page).getByTestId("terminal-tab")).toHaveCount(1);
});

Then("the Terminal tab shows no shell and offers New terminal", async ({ page }) => {
  await expect(body(page)).toBeVisible();
  await expect(body(page).getByTestId("terminal-tab")).toHaveCount(0);
  await expect(body(page).getByTestId("terminal-new")).toBeVisible();
});

When("I click the Terminal tab New terminal button", async ({ page }) => {
  await body(page).getByTestId("terminal-new").click();
});

When("I close the last shell of the Terminal tab", async ({ page }) => {
  await body(page).getByRole("button", { name: /^Close / }).first().click();
});

When("I open the terminal with the shortcut", async ({ page }) => {
  await page.keyboard.press("Control+Backquote");
});

When("I open Settings and choose the terminal position {string}", async ({ page }, label: string) => {
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-terminal").click();
  await page.getByTestId("settings-terminal-position").click();
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(page.getByTestId("settings-terminal-position")).toContainText(label);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-terminal")).toHaveCount(0);
});

When("I move the Terminal tab to the bottom panel from its tab menu", async ({ page }) => {
  await tab(page).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move Terminal to bottom panel", exact: true }).click();
});

When("I click the session tab of the terminal", async ({ page }) => {
  await page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id^="terminal:"]) [role="tab"]').first().click();
});

When("I click the Terminal strip tab with the mouse", async ({ page }) => {
  await tab(page).first().locator('[role="tab"]').click();
});

When("I select the Terminal strip tab with the arrow keys", async ({ page }) => {
  const session = page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id^="terminal:"]) [role="tab"]').first();
  await session.focus();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page).first().locator('[role="tab"]')).toHaveAttribute("aria-selected", "true");
});

Then("the Terminal tab is the selected tab", async ({ page }) => {
  await expect(tab(page).first().locator('[role="tab"]')).toHaveAttribute("aria-selected", "true");
  await expect(body(page)).toBeVisible();
});

When("I remember the shell title", async ({ page }) => {
  title = (await page.getByTestId("terminal-tab").first().innerText()).trim();
  expect(title).not.toBe("");
});

Then("the shell title is unchanged", async ({ page }) => {
  await expect(page.getByTestId("terminal-tab").filter({ visible: true })).toHaveText([title]);
});

When("I pick the first session row in the tab switcher", async ({ page }) => {
  await page.getByRole("option").filter({ hasNotText: "Terminal ·" }).first().click();
  await expect(body(page)).toBeHidden();
});
