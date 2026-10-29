import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { openProject, REPLY_PROMPT } from "../support/flow.ts";
import { TURN_MS } from "../support/ui.ts";
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
  // Another folder's Terminal tab body stays mounted but hidden: click the shown one.
  await body(page).getByTestId("terminal-new").locator("visible=true").click();
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

When("I open a session in a second project folder with a finished reply", async ({ page, project }) => {
  const path = `${project.path}-b`;
  mkdirSync(join(path, ".claude"), { recursive: true });
  writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }, null, 2));
  await openProject(page, path);
  const fresh = page.getByTestId("new-session-tab");
  await expect(fresh).toBeVisible({ timeout: 60_000 });
  await expect(fresh.getByTestId("project-chip")).toContainText(basename(path), { timeout: 30_000 });
  await fresh.getByTestId("session-model").click();
  await page.getByRole("option", { name: "Haiku" }).click();
  await expect(fresh.getByTestId("session-model")).toContainText("Haiku");
  await fresh.getByRole("combobox", { name: "First prompt" }).fill(REPLY_PROMPT);
  await expect(fresh.getByTestId("send")).toBeEnabled();
  await fresh.getByTestId("send").click();
  await expect(page.getByTestId("assistant-text").last()).toHaveText(/\S/, { timeout: TURN_MS });
  await expect(page.locator('[data-testid="send"][data-state="idle"]').last()).toBeVisible({ timeout: TURN_MS });
});

Then("there are {int} {string} tabs", async ({ page }, n: number, _kind: string) => {
  await expect(tab(page)).toHaveCount(n);
});

Then("the Terminal tabs are labeled with the two project names", async ({ page, project }) => {
  const labels = await tab(page).allInnerTexts();
  expect(labels.length).toBe(2);
  expect(labels.every((l) => l.includes("Terminal ·"))).toBe(true);
  expect(labels.some((l) => l.includes(project.name))).toBe(true);
  expect(labels.some((l) => l.includes(`${project.name}-b`))).toBe(true);
});

When("the terminal code loads slowly", async ({ page }) => {
  await page.route(/terminal-panel-[^/]*\.js$/, async (route) => {
    await new Promise((r) => setTimeout(r, 2_500));
    await route.continue();
  });
});

Then("the shell has the focus within {int} seconds", async ({ page }, s: number) => {
  await expect.poll(() => focused(page), { timeout: s * 1000 }).toBe(true);
});

Then("the Terminal tab of the second project is the selected tab", async ({ page, project }) => {
  const second = tab(page).filter({ hasText: `${project.name}-b` });
  await expect(second).toHaveCount(1);
  await expect(second.locator('[role="tab"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-pane-tab-body^="terminal:"]:visible')).toHaveCount(1);
});

const shownBody = (page: Page) => page.locator('[data-pane-tab-body^="terminal:"]:visible');

When("I select {string} in the Terminal tab", async ({ page }, name: string) => {
  await shownBody(page).getByRole("tab", { name, exact: true }).click();
});

Then("the Terminal tab selects {string}", async ({ page }, name: string) => {
  await expect(shownBody(page).getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
});

When("I click the Terminal tab of the {word} project", async ({ page, project }, which: string) => {
  const second = which === "second";
  const label = tab(page).filter(second ? { hasText: `${project.name}-b` } : { hasNotText: `${project.name}-b` });
  await expect(label).toHaveCount(1);
  await label.locator('[role="tab"]').click();
});

Then("the terminal position hint mentions {string}", async ({ page }, text: string) => {
  // The choose step closed Settings: open it again at the Terminal group.
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-terminal").click();
  await expect(page.locator("#settings-terminal-position-hint")).toContainText(text);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-terminal")).toHaveCount(0);
});
