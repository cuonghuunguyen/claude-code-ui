import { expect, type Locator, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const PANE: Record<string, string> = { Plan: "plan", Files: "files", "Git graph": "graph", Changes: "changes", Terminal: "terminal" };
const dockTab = (page: Page, kind: string) => page.locator(`[data-testid="side-panel"] [data-pane-tab="${PANE[kind]}"], [data-testid="bottom-panel"] [data-pane-tab="${PANE[kind]}"]`).first();
const stripTab = (page: Page, kind: string) => page.locator(`[data-testid="tab"][data-tab-id^="${PANE[kind]}:"] [role="tab"]`).first();
const fileTab = (page: Page, name: string) => page.locator('[data-testid="tab"][data-tab-id^="file:"]').filter({ hasText: name }).first();
const firstSession = (page: Page) => page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id="new"]):not([data-tab-id*=":"])').first();
const dockedTab = (page: Page) => page.locator("[data-docked-tab]").first();
const strip = (page: Page) => page.getByTestId("tab-strip-area");
const sessionArea = (page: Page) => page.getByTestId("session-area");
const panel = (page: Page, area: string) => page.getByTestId(`${area}-panel`);
// Chromium's HTML5 drag: Playwright's dragTo fires the drag events.
const drop = (from: Locator, to: Locator, position?: { x: number; y: number }) => from.dragTo(to, position ? { targetPosition: position } : undefined);
const edgeAt = async (page: Page, edge: string) => {
  const b = (await sessionArea(page).boundingBox())!;
  return { x: edge === "left" ? 12 : edge === "right" ? b.width - 12 : b.width / 2, y: edge === "top" ? 12 : edge === "bottom" ? b.height - 12 : b.height / 2 };
};
/** Hover only: press, move over the target, keep the button down. */
async function hold(from: Locator, page: Page, x: number, y: number) {
  await from.hover();
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
}
const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

When("I drag the {string} dock tab onto the tab strip", async ({ page }, kind: string) => {
  await drop(dockTab(page, kind), strip(page));
});

When("I drag the {string} dock tab onto the session area", async ({ page }, kind: string) => {
  await drop(dockTab(page, kind), sessionArea(page));
});

When("I drag the {string} dock tab onto the {word} edge of the session area", async ({ page }, kind: string, edge: string) => {
  await drop(dockTab(page, kind), sessionArea(page), await edgeAt(page, edge));
});

When("I start dragging the {string} dock tab over the session area", async ({ page }, kind: string) => {
  const c = await centre(sessionArea(page));
  await hold(dockTab(page, kind), page, c.x, c.y);
});

When("I start dragging the {string} dock tab over the {word} edge of the session area", async ({ page }, kind: string, edge: string) => {
  const b = (await sessionArea(page).boundingBox())!;
  const at = await edgeAt(page, edge);
  await hold(dockTab(page, kind), page, b.x + at.x, b.y + at.y);
});

When("I start dragging the {string} dock tab over the tab strip", async ({ page }, kind: string) => {
  const c = await centre(strip(page));
  await hold(dockTab(page, kind), page, c.x, c.y);
});

When("I drag the {string} tab onto the {word} panel", async ({ page }, kind: string, area: string) => {
  await drop(stripTab(page, kind), panel(page, area));
});

When("I drag the {string} tab onto the bottom drop strip", async ({ page }, kind: string) => {
  await drop(stripTab(page, kind), page.getByTestId("drop-bottom"));
});

When("I drag the file tab {string} onto the {word} panel", async ({ page }, name: string, area: string) => {
  await drop(fileTab(page, name).locator('[role="tab"]'), panel(page, area));
});

When("I start dragging the file tab {string} over the {word} panel", async ({ page }, name: string, area: string) => {
  const c = await centre(panel(page, area));
  await hold(fileTab(page, name), page, c.x, c.y);
});

When("I drag the first session tab onto the {word} panel", async ({ page }, area: string) => {
  await drop(firstSession(page), panel(page, area));
});

When("I drag the docked session tab onto the tab strip", async ({ page }) => {
  await drop(dockedTab(page), strip(page));
});

Then("no drop target is outlined", async ({ page }) => {
  await expect(page.locator("[data-drop-target]")).toHaveCount(0);
});

Then("the {word} panel has the {string} tab selected", async ({ page }, area: string, kind: string) => {
  await expect(panel(page, area).locator(`[data-pane-tab="${PANE[kind]}"][aria-selected="true"]`)).toBeVisible();
});
