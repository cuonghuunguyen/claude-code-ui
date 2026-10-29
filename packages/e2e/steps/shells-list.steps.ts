import { expect, type Locator, type Page } from "@playwright/test";
import { TOOL_STATUS, TURN_MS, promptBox, sendButton } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const dialog = (page: Page) => page.getByTestId("shells-dialog");
const rowOf = (page: Page, text: string) => dialog(page).getByTestId("shell-row").filter({ hasText: text });
const output = (page: Page) => dialog(page).getByTestId("shell-output");
const outputLines = async (page: Page) => ((await output(page).innerText()).match(/\S+/g) ?? []).length;
const BG = (cmd: string) => `Use the Bash tool with run_in_background set to true to run exactly this command and nothing else: ${cmd}. Then reply only "started".`;
const FG = (cmd: string) => `Use the Bash tool to run exactly this command in the foreground (no run_in_background) and nothing else: ${cmd}`;

const allowBtn = (page: Page) => page.getByTestId("permission-panel").getByRole("button", { name: "Allow once" });
const allow = (page: Page) => allowBtn(page).click({ timeout: TURN_MS });

// Claude may or may not ask (a repeated command can be allowed already): allow when asked, end when the visible session is idle.
async function settle(page: Page): Promise<void> {
  const sent = page.locator('[data-testid="user-message"]:not([data-pending]):visible').first();
  await expect(sent).toBeVisible({ timeout: TURN_MS });
  const end = Date.now() + TURN_MS;
  while (Date.now() < end) {
    if (await allowBtn(page).isVisible()) await allowBtn(page).click();
    else if (await page.locator('[data-testid="send"][data-state="idle"]:visible').count()) return;
    await page.waitForTimeout(500);
  }
  throw new Error("the turn did not end");
}

When("I ask Claude to run {string} in the background", async ({ page }, cmd: string) => {
  await promptBox(page).fill(BG(cmd));
  await sendButton(page).click();
  await settle(page);
});

When("I run {string} in the foreground and move it to the background", async ({ page }, cmd: string) => {
  await promptBox(page).fill(FG(cmd));
  await sendButton(page).click();
  await allow(page);
  const b = page.getByTestId("tool-card").filter({ hasText: cmd }).getByTestId("run-in-background");
  await expect(b).toBeVisible({ timeout: 30_000 });
  await b.click();
  await settle(page);
});

When("I open a second session that runs {string} in the background", async ({ page, project }, cmd: string) => {
  await page.getByTestId("tab-new").first().click();
  const fresh = page.getByTestId("new-session-tab");
  await expect(fresh).toBeVisible();
  await fresh.getByTestId("session-model").click();
  await page.getByRole("option", { name: "Haiku" }).click();
  await expect(fresh.getByTestId("session-model")).toContainText("Haiku");
  await expect(fresh.getByTestId("project-chip")).toContainText(project.name);
  await fresh.getByRole("combobox", { name: "First prompt" }).fill(BG(cmd));
  await expect(fresh.getByTestId("send")).toBeEnabled();
  await fresh.getByTestId("send").click();
  await settle(page);
});

When("I open the shells list from the status bar", async ({ page }) => {
  await page.locator('[data-field="shells"]').first().click();
  await expect(dialog(page)).toBeVisible();
});

When("I close the shells list", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
});

const paneOf = (page: Page, i: number): Locator => page.locator('[role="group"][aria-label]').filter({ has: page.locator('button[data-field="shells"]') }).nth(i);
const fieldOfPane = (page: Page, i: number): Locator => paneOf(page, i).locator('button[data-field="shells"]');

When("I click the shells field of pane {int}", async ({ page }, n: number) => {
  await fieldOfPane(page, n - 1).click();
  await expect(dialog(page)).toBeVisible();
});

When("I reach the shells field of pane {int} with Tab and press Enter", async ({ page }, n: number) => {
  const field = fieldOfPane(page, n - 1);
  await expect(field).toBeVisible();
  // Start from the pane's prompt box and Tab forward until the field has the focus.
  await paneOf(page, n - 1).getByRole("combobox", { name: /^(First prompt|Prompt)$/ }).focus();
  let focused = false;
  for (let i = 0; i < 40 && !focused; i++) {
    await page.keyboard.press("Tab");
    focused = await field.evaluate((el) => el === document.activeElement);
  }
  expect(focused, "Tab reaches the shells field").toBe(true);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
});

Then("the shells list shows {string} as {word}", async ({ page }, text: string, outcome: string) => {
  await expect(rowOf(page, text)).toHaveAttribute("data-status", { ...TOOL_STATUS, failed: "error" }[outcome]!, { timeout: TURN_MS });
});

Then("the shells list shows {string}", async ({ page }, text: string) => {
  await expect(rowOf(page, text)).toHaveCount(1, { timeout: 15_000 });
});

Then("the shells list does not show {string}", async ({ page }, text: string) => {
  await expect(dialog(page).getByTestId("shell-row").first()).toBeVisible();
  await expect(rowOf(page, text)).toHaveCount(0);
});

Then("the shells list has {int} rows", async ({ page }, n: number) => {
  await expect(dialog(page).getByTestId("shell-row")).toHaveCount(n, { timeout: 15_000 });
});

When("I open the {string} shell", async ({ page }, text: string) => {
  await rowOf(page, text).click();
  await expect(dialog(page).getByTestId("shell-meta")).toBeVisible();
});

Then("the shell output shows {string}", async ({ page }, text: string) => {
  await expect(output(page)).toContainText(text, { timeout: 20_000 });
});

Then("the shell output is not an error", async ({ page }) => {
  await expect(dialog(page).getByText(/Output not available/)).toHaveCount(0);
  await expect(output(page)).toBeVisible();
});

Then("the shell output shows its text or {string}", async ({ page }, text: string) => {
  await expect(output(page).or(dialog(page).getByText(text))).toBeVisible({ timeout: 20_000 });
});

Then("the shell output grows", async ({ page }) => {
  const before = await outputLines(page);
  await expect.poll(() => outputLines(page), { timeout: 10_000 }).toBeGreaterThan(before);
});

Then("the shell details show {string}", async ({ page }, text: string) => {
  await expect(dialog(page).getByTestId("shell-meta")).toContainText(text, { timeout: TURN_MS });
});

Then("the shell details show a run time", async ({ page }) => {
  await expect(dialog(page).getByTestId("shell-meta")).toHaveText(/·\s*(\d+s|\d+m \d\ds|\d+h \d\dm)\s*$/);
});

When("I kill the shell and confirm", async ({ page }) => {
  await dialog(page).getByTestId("shell-kill").click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog").filter({ hasText: "Kill shell?" })).getByRole("button", { name: "Kill", exact: true }).click();
});

Then("the shell has no Kill button", async ({ page }) => {
  await expect(dialog(page).getByTestId("shell-kill")).toHaveCount(0, { timeout: TURN_MS });
});

Then("the shell rows are at least 44 px high", async ({ page }) => {
  const rows = dialog(page).getByTestId("shell-row");
  for (let i = 0; i < (await rows.count()); i++) expect((await rows.nth(i).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
});

Then("the Kill button is reachable and at least 44 px high", async ({ page }) => {
  const kill = dialog(page).getByTestId("shell-kill");
  await kill.scrollIntoViewIfNeeded();
  const box = await kill.boundingBox();
  const vp = page.viewportSize()!;
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
});

Then("the shells dialog fits the viewport", async ({ page }) => {
  const box = await dialog(page).boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(await dialog(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

When("I wait for the shell to leave the status bar", async ({ page }) => {
  await expect(page.locator('[data-field="shells"]')).toHaveCount(0, { timeout: 60_000 });
});
