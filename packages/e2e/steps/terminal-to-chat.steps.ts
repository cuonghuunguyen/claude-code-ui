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

// Not "I type ... in the terminal": it waits for the echoed command, which scrolls off screen once a long output ends.
When("I run {string} in the terminal and wait for its output to end with {string}", async ({ page }, cmd: string, last: string) => {
  await expect(view(page).locator(".xterm")).toBeVisible({ timeout: 30_000 });
  await view(page).locator(".xterm").click();
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  // Exact row: the echoed command also contains the last line's text and renders before any output.
  await expect(rows(page).filter({ hasText: new RegExp(`^\\s*${last}\\s*$`) }).first()).toBeVisible({ timeout: 30_000 });
  // The prompt redraws after the output (git status segment) and scrolls the view to the bottom: wait until the rows stop changing.
  let seen = "";
  let since = Date.now();
  await expect
    .poll(
      async () => {
        const now = await view(page).locator(".xterm-rows").innerText();
        if (now !== seen) (seen = now), (since = Date.now());
        return Date.now() - since >= 1500;
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(true);
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

// Select from far up down to the last visible row. The end row must be on screen at release for the scrollbar-less drag in the cap scenario.
When("I select the terminal output over the cap down to the last visible row", async ({ page }) => {
  const screen = (await view(page).locator(".xterm-screen").boundingBox())!;
  const x = screen.x + 4;
  const top = () => rows(page).first().innerText().then((t) => Number.parseInt(t, 10));
  const wheel = async (dy: number) => {
    for (let k = 0; k < 20; k++) await page.mouse.wheel(0, dy);
  };
  // 8000-character cap; `seq 1 5000` is ~24000 characters, so from line ~3000 on is over the cap.
  await page.mouse.move(x, screen.y + screen.height / 2);
  await expect.poll(async () => (await wheel(-3_000), await top()), { timeout: 60_000, intervals: [100] }).toBeLessThanOrEqual(3000);
  await page.mouse.move(x, screen.y + 10);
  await page.mouse.down();
  await page.mouse.move(x, screen.y + screen.height - 8, { steps: 8 });
  await expect
    .poll(async () => (await wheel(3_000), await page.mouse.move(x, screen.y + screen.height - 8 - (Date.now() % 2)), await top()), { timeout: 60_000, intervals: [100] })
    .toBeGreaterThanOrEqual(4990);
  // Move across rows before releasing so the selection end is the last visible row.
  await page.mouse.move(x, screen.y + screen.height - 40, { steps: 4 });
  await page.mouse.move(x, screen.y + screen.height - 8, { steps: 4 });
  await page.mouse.up();
});

Then("the session tab is the selected tab", async ({ page }) => {
  await expect(page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id^="terminal:"]) [role="tab"]').first()).toHaveAttribute("aria-selected", "true");
});

When("I open the terminal pane on the phone", async ({ page }) => {
  await pickPane(page, "terminal");
  await expect(view(page).locator(".xterm")).toBeVisible({ timeout: 30_000 });
});

const rowsWith = (page: Page, text: string) => rows(page).filter({ hasText: new RegExp(`^\\s*${text}\\s*$`) });

// GH-762: the menu stays while the selection end is scrolled out of view.
When("I scroll the terminal up until {string} is out of view", async ({ page }, text: string) => {
  const screen = (await view(page).locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await expect.poll(async () => (await page.mouse.wheel(0, -120), await rowsWith(page, text).count()), { timeout: 30_000, intervals: [100] }).toBe(0);
});

When("I scroll the terminal to the bottom", async ({ page }) => {
  const screen = (await view(page).locator(".xterm-screen").boundingBox())!;
  await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await expect.poll(async () => (await page.mouse.wheel(0, 300), await rowsWith(page, "300").count()), { timeout: 30_000, intervals: [100] }).toBeGreaterThan(0);
});

When("I drag the terminal scrollbar up", async ({ page }) => {
  const slider = view(page).locator(".scrollbar.vertical .slider");
  const box = (await slider.boundingBox())!;
  const first = await rows(page).first().innerText();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => rows(page).first().innerText()).not.toBe(first);
});

Then("the terminal selection menu sits inside the terminal screen", async ({ page }) => {
  const screen = (await view(page).locator(".xterm-screen").boundingBox())!;
  const m = (await floating(page).boundingBox())!;
  expect(m.y).toBeGreaterThanOrEqual(screen.y - m.height - 16);
  expect(m.y).toBeLessThanOrEqual(screen.y + screen.height + m.height + 16);
  expect(m.x + m.width / 2).toBeGreaterThanOrEqual(screen.x);
  expect(m.x + m.width / 2).toBeLessThanOrEqual(screen.x + screen.width);
});

When("I drag a terminal selection upward from {string} until {string} is out of view", async ({ page }, from: string, gone: string) => {
  const screen = (await view(page).locator(".xterm-screen").boundingBox())!;
  const { box, cell } = await rowBox(page, from);
  const x = box.x + cell * (from.length + 0.5);
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, screen.y + 5, { steps: 8 });
  await expect
    .poll(async () => (await page.mouse.wheel(0, -300), await page.mouse.move(x, screen.y + 5 + (Date.now() % 2)), await rowsWith(page, gone).count()), { timeout: 30_000, intervals: [100] })
    .toBe(0);
  await page.mouse.up();
});
