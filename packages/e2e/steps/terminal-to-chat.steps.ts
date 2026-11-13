import { expect, type Page } from "@playwright/test";
import { openApp, openProject, prepareHaikuSession } from "../support/flow.ts";
import { pickPane, promptBox } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const view = (page: Page) => page.locator('[data-testid="terminal-view"]:visible').first();
const rows = (page: Page) => view(page).locator(".xterm-rows > div");
const floating = (page: Page) => page.getByTestId("terminal-selection");
const ctx = (page: Page) => page.getByTestId("terminal-menu");

/** Box of the row whose text is exactly `text` and of one cell. */
async function rowBox(page: Page, text: string) {
  const row = rows(page).filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) }).first();
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  const span = (await row.locator("span").first().boundingBox())!;
  return { box, cell: span.width / text.length };
}

Given("I start a Haiku session with the terminal docked", async ({ page, project, daemon }) => {
  await openApp(page, daemon);
  await openProject(page, project.path);
  await prepareHaikuSession(page, project.name);
  await page.getByTestId("terminal-toggle-titlebar").click();
  await expect(view(page).locator(".xterm")).toBeVisible({ timeout: 30_000 });
});

When("I select the terminal output line {string}", async ({ page }, text: string) => {
  const { box, cell } = await rowBox(page, text);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + cell * (text.length + 0.5), y, { steps: 6 });
  await page.mouse.up();
});

Then("the terminal selection menu offers {string}", async ({ page }, name: string) => {
  await expect(floating(page)).toBeVisible();
  await expect(page.getByTestId("terminal-selection-add")).toHaveText(name);
});

// Probe of xterm's selection end against the menu: logs both boxes; asserts the menu is on the selected row (above or below it, not further).
Then("the terminal selection menu sits at the end of the selection", async ({ page }) => {
  const { box } = await rowBox(page, "red-710");
  const m = (await floating(page).boundingBox())!;
  console.log("PROBE row", JSON.stringify(box), "menu", JSON.stringify(m));
  const gapBelow = m.y - (box.y + box.height);
  const gapAbove = box.y - (m.y + m.height);
  console.log("PROBE gapBelow", gapBelow, "gapAbove", gapAbove);
  expect(Math.min(Math.abs(gapBelow), Math.abs(gapAbove))).toBeLessThanOrEqual(12);
});

When("I click Add to chat in the terminal selection menu", async ({ page }) => {
  await page.getByTestId("terminal-selection-add").click();
});

When("I close the terminal menu", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(ctx(page)).toHaveCount(0);
});

When("I click Add to chat in the terminal menu", async ({ page }) => {
  await page.getByTestId("terminal-menu-add").click();
});

Then("the terminal selection menu is gone", async ({ page }) => {
  await expect(floating(page)).toHaveCount(0);
});

Then("the prompt box has the terminal output block with {string} for {string}", async ({ page }, text: string, title: string) => {
  await expect.poll(() => promptBox(page).inputValue()).toContain(`Output of terminal "${title}"`);
  const v = await promptBox(page).inputValue();
  expect(v).toContain("```text");
  expect(v).toContain(text);
  expect(v).not.toContain("\x1b");
  expect(v).not.toContain("\\e[");
  expect(v).not.toMatch(/\[31m/);
});

Then("the prompt box has the terminal output block for {string} marked truncated", async ({ page }, title: string) => {
  await expect.poll(() => promptBox(page).inputValue()).toContain(`Output of terminal "${title}"`);
  expect(await promptBox(page).inputValue()).toMatch(/\(truncated: last [\d,]+ of [\d,]+ lines\)/);
});

When("I right click the empty terminal area", async ({ page }) => {
  const b = (await view(page).locator(".xterm-screen").boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 6, { button: "right" });
});

When("I right click the selected terminal output", async ({ page }) => {
  const { box, cell } = await rowBox(page, "red-710");
  await page.mouse.click(box.x + cell * 2, box.y + box.height / 2, { button: "right" });
});

Then("the terminal menu offers Add to chat disabled with a reason", async ({ page }) => {
  await expect(ctx(page)).toBeVisible();
  const add = page.getByTestId("terminal-menu-add");
  await expect(add).toHaveAttribute("aria-disabled", "true");
  await expect(add).toHaveAttribute("title", /\S/);
});

Then("the terminal menu offers Add to chat enabled", async ({ page }) => {
  await expect(ctx(page)).toBeVisible();
  await expect(page.getByTestId("terminal-menu-add")).not.toHaveAttribute("aria-disabled", "true");
});

When("I select the terminal output from the last visible row to the top of its scrollback", async ({ page }) => {
  await expect(rows(page).filter({ hasText: "5000" }).first()).toBeVisible({ timeout: 15_000 });
  const screen = (await view(page).locator(".xterm-screen").boundingBox())!;
  const x = screen.x + 4;
  await page.mouse.click(x, screen.y + screen.height - 8);
  await page.mouse.move(x, screen.y + 10);
  await page.mouse.wheel(0, -200_000);
  await page.waitForTimeout(500);
  await page.keyboard.down("Shift");
  await page.mouse.click(x, screen.y + 8);
  await page.keyboard.up("Shift");
});

Then("the session tab is the selected tab", async ({ page }) => {
  await expect(page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id^="terminal:"]) [role="tab"]').first()).toHaveAttribute("aria-selected", "true");
});

When("I open the terminal pane on the phone", async ({ page }) => {
  await pickPane(page, "terminal");
  await expect(view(page).locator(".xterm")).toBeVisible({ timeout: 30_000 });
});
