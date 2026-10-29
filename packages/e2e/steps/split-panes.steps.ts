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
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 5 });
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
