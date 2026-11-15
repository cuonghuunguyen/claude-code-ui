import { expect } from "@playwright/test";
import { When } from "./fixtures.ts";

const side = (page: import("@playwright/test").Page) => page.getByTestId("side-panel");
/** Desktop: a tab of the side panel. Phone: the Panes tab list. By the pane id, not the tab text: language.feature opens it in Vietnamese. */
async function openPane(page: import("@playwright/test").Page, pane: string): Promise<void> {
  const desktopTab = side(page).getByTestId(`pane-${pane}`);
  const phoneTab = page.locator(`[role="tablist"] [data-testid="pane-${pane}"]:visible`).first();
  // After a reload the panel renders late: wait for either before choosing.
  await desktopTab.or(phoneTab).first().waitFor({ timeout: 15_000 });
  if (await desktopTab.isVisible()) return void (await desktopTab.click());
  await phoneTab.click();
}

When("I open the Changes tab of the side panel", async ({ page }) => {
  await openPane(page, "changes");
  await expect(page.getByTestId("changes-panel")).toBeVisible();
});

When("I choose the {string} diff mode", async ({ page }, mode: string) => {
  await page.getByTestId("diff-mode").click();
  await page.getByRole("option", { name: mode }).click();
  await expect(page.getByTestId("diff-mode")).toContainText(mode);
});

When("I open the Graph tab of the side panel", async ({ page }) => {
  await openPane(page, "graph");
  await expect(page.getByTestId("graph-panel")).toBeVisible();
});
