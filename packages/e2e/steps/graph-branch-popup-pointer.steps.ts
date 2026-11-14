import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const popup = (page: Page) => page.getByTestId("branch-popup");
const trigger = (page: Page) => page.getByTestId("graph-panel").getByTestId("graph-filter-branch");

// A pointer that does not move while the popup opens or its list changes under it (GH-777): park it where the popup's rows will appear.
When("the mouse pointer rests where the Graph branch popup will list its rows", async ({ page }) => {
  await expect(trigger(page)).toBeVisible({ timeout: 30_000 });
  const b = (await trigger(page).boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + b.height + 90);
});

When("I open the Graph branch popup with the keyboard", async ({ page }) => {
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await expect(popup(page)).toBeVisible({ timeout: 30_000 });
  await expect(popup(page).getByTestId("branch-popup-row").first()).toBeVisible({ timeout: 30_000 });
});

When("I move the mouse over the branch popup row {string}", async ({ page }, name: string) => {
  const r = popup(page).getByTestId("branch-popup-row").filter({ has: page.getByText(name, { exact: true }) });
  await expect(r).toHaveCount(1);
  const b = (await r.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2 - 20, b.y + b.height / 2);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
});

// Layout and the pointer's own events settle in a few frames: give a wrongly opened pane time to show before judging.
Then("the branch popup actions stay closed", async ({ page }) => {
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("branch-popup-sub")).toHaveCount(0);
});
