import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const PREFIX: Record<string, string> = { Plan: "plan", Files: "files", Terminal: "terminal" };
const stripTab = (page: Page, kind: string) => page.locator(`[data-testid="tab"][data-tab-id^="${PREFIX[kind] ?? "graph"}:"]`).first();
const paneSplit = (page: Page, kind: string) => page.locator(`[data-testid="split"][data-pane-tab-body^="${PREFIX[kind]}:"]`);
const sessionSplit = (page: Page) => page.locator('[data-testid="split"]:not([data-pane-tab-body])');
const area = (page: Page) => page.getByTestId("session-area");

Then("the {string} tab is shown in a split", async ({ page }, kind: string) => {
  await expect(paneSplit(page, kind)).toBeVisible();
});

Then("the active split shows the {string} tab", async ({ page }, kind: string) => {
  await expect(paneSplit(page, kind)).toHaveAttribute("data-active", "");
});

Then("the menu item {string} is enabled", async ({ page }, label: string) => {
  const item = page.getByRole("menuitem", { name: label, exact: true });
  await expect(item).toBeVisible();
  await expect(item).not.toHaveAttribute("aria-disabled", "true");
});

Then("the menu shows {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("tab-menu-splitNote")).toHaveText(text);
});

When("I open the menu of the {string} tab", async ({ page }, kind: string) => {
  await stripTab(page, kind).click({ button: "right" });
});

When("I close the menu", async ({ page }) => {
  await page.keyboard.press("Escape");
});

Then("the prompt box of the session split has the focus", async ({ page }) => {
  await expect(sessionSplit(page).locator('textarea[aria-label="Prompt"]')).toBeFocused();
  await expect(sessionSplit(page)).toHaveAttribute("data-active", "");
});

When("I hold the {string} tab over the right edge of the session area", async ({ page }, kind: string) => {
  const tab = stripTab(page, kind);
  await tab.hover();
  await page.mouse.down();
  const box = (await area(page).boundingBox())!;
  // Not at the very edge: with the side panel hidden, a drop strip covers it.
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, { steps: 5 });
});

Then("the drop overlay says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("split-drop")).toHaveText(text);
});

When("I release the mouse", async ({ page }) => {
  await page.mouse.up();
});

Then("the sidebar highlights the first session", async ({ page }) => {
  const first = await page.locator('[data-testid="tab"]:not([data-tab-id*=":"]):not([data-tab-id=""])').first().getAttribute("data-tab-id");
  await expect(page.locator('[data-testid="session-item"][aria-current="page"]')).toHaveAttribute("data-session-id", first!);
});

Then("the {string} tab is not shown in a split", async ({ page }, kind: string) => {
  await expect(paneSplit(page, kind)).toHaveCount(0);
});

When("I hide the side panel", async ({ page }) => {
  const toggle = page.getByTestId("panel-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "true") await toggle.click();
  await expect(page.getByTestId("side-panel")).toBeHidden();
});

const paletteHas = async (page: Page, title: string) => {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill(title);
  const n = await palette.getByRole("option", { name: new RegExp(`^${title}`, "i") }).count();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  return n > 0;
};

Then("the command palette lists {string}", async ({ page }, title: string) => {
  expect(await paletteHas(page, title)).toBe(true);
});

Then("the command palette does not list {string}", async ({ page }, title: string) => {
  expect(await paletteHas(page, title)).toBe(false);
});

Then("the session split is shown", async ({ page }) => {
  await expect(sessionSplit(page)).toBeVisible();
});

Then("the session split is active", async ({ page }) => {
  await expect(sessionSplit(page)).toHaveAttribute("data-active", "");
});

When("I hold the {string} tab over the session split", async ({ page }, kind: string) => {
  await stripTab(page, kind).hover();
  await page.mouse.down();
  const t = (await stripTab(page, kind).boundingBox())!;
  await page.mouse.move(t.x + t.width / 2, t.y + t.height + 40, { steps: 3 });
  const box = (await sessionSplit(page).boundingBox())!;
  const a = (await area(page).boundingBox())!;
  // The outer thirds of the whole area are edge zones: aim at the part of the split inside the middle third.
  const x = (Math.max(box.x, a.x + a.width / 3) + Math.min(box.x + box.width, a.x + (2 * a.width) / 3)) / 2;
  await page.mouse.move(x, box.y + box.height / 2, { steps: 8 });
  // Chromium sends dragover on the next move: one more so the overlay follows the last position.
  await page.mouse.move(x + 2, box.y + box.height / 2, { steps: 2 });
});

Then("the terminal of the split is ready", async ({ page }) => {
  await expect(paneSplit(page, "Terminal").locator(".xterm")).toBeVisible();
});

Then("the sidebar highlights the session of the session split", async ({ page }) => {
  const id = (await sessionSplit(page).getAttribute("id"))!.replace(/^split-/, "");
  await expect(page.locator('[data-testid="session-item"][aria-current="page"]')).toHaveAttribute("data-session-id", id);
});

// No click first: the existing "I type {string} in the terminal" clicks the terminal and so hides a missing focus.
When("I type {string} on the keyboard and press Enter", async ({ page }, text: string) => {
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
});

Then("the terminal columns fit its split", async ({ page }) => {
  const term = paneSplit(page, "Terminal").locator(".xterm");
  await expect(term).toBeVisible();
  await term.click();
  await page.keyboard.type("echo COLS=$(tput cols)");
  await page.keyboard.press("Enter");
  const rows = paneSplit(page, "Terminal").locator(".xterm-rows");
  await expect(rows).toContainText(/COLS=\d+/, { timeout: 15_000 });
  const cols = Number(/COLS=(\d+)/.exec(await rows.innerText())![1]);
  const screen = (await paneSplit(page, "Terminal").locator(".xterm-screen").boundingBox())!;
  const box = (await term.boundingBox())!;
  const cell = screen.width / cols;
  // The fit leaves room for the scrollbar: up to 2 columns of the box are not used.
  expect(cols).toBeGreaterThanOrEqual(20);
  expect(Math.floor(box.width / cell) - cols).toBeGreaterThanOrEqual(0);
  expect(Math.floor(box.width / cell) - cols).toBeLessThanOrEqual(2);
});

Then("the split hint is shown", async ({ page }) => {
  await expect(page.getByTestId("split-hint")).toBeVisible();
});

Then("the plan tab is the selected tab", async ({ page }) => {
  await expect(page.locator('[data-testid="tab"][data-tab-id^="plan:"] [role="tab"]')).toHaveAttribute("aria-selected", "true");
});
