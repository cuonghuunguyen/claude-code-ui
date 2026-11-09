import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const popup = (page: Page) => page.getByTestId("branch-popup");
const row = (page: Page, name: string) => popup(page).getByTestId("branch-popup-row").filter({ has: page.getByText(name, { exact: true }) });

When("I open the Graph branch popup", async ({ page }) => {
  await page.getByTestId("graph-panel").getByTestId("graph-filter-branch").click();
  await expect(popup(page)).toBeVisible({ timeout: 30_000 });
});

Then("the branch popup search box is focused", async ({ page }) => {
  await expect(popup(page).getByTestId("branch-popup-search")).toBeFocused();
});

Then("the branch popup search box is empty", async ({ page }) => {
  await expect(popup(page).getByTestId("branch-popup-search")).toHaveValue("");
});

Then("the branch popup lists {string}", async ({ page }, name: string) => {
  await expect(row(page, name)).toHaveCount(1);
});

Then("the branch popup does not list {string}", async ({ page }, name: string) => {
  await expect(row(page, name)).toHaveCount(0);
});

// Typing without focusing the box first: a key anywhere in the popup goes to the search box.
When("I type {string} in the branch popup", async ({ page }, text: string) => {
  await page.keyboard.type(text);
});

When("I press {string} in the branch popup", async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

When("I press {string} in the branch popup actions", async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

Then("the Graph branch filter shows {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("graph-panel").getByTestId("graph-filter-branch")).toHaveText(name);
});

When("I open the actions of the branch {string} in the branch popup", async ({ page }, name: string) => {
  const r = row(page, name);
  await r.hover();
  await r.getByTestId("branch-popup-more").click();
  const sub = page.getByTestId("branch-popup-sub");
  await expect(sub).toBeVisible();
  await expect(sub.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 });
});

Then("the branch popup actions offer {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("branch-popup-sub").getByText("Loading…")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("branch-popup-sub").getByRole("menuitem", { name, exact: true })).toHaveCount(1);
});

Then("the branch popup actions do not offer {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("branch-popup-sub").getByRole("menuitem", { name, exact: true })).toHaveCount(0);
});

When("I pick {string} in the branch popup actions", async ({ page }, name: string) => {
  await page.getByTestId("branch-popup-sub").getByRole("menuitem", { name, exact: true }).click();
});

Then("every branch popup action button is at least 44px high", async ({ page }) => {
  const more = popup(page).getByTestId("branch-popup-more");
  // The branches arrive after the popup opens: wait for the first button before counting.
  await expect(more.first()).toBeVisible({ timeout: 30_000 });
  const n = await more.count();
  // The popup scales in (scale-95 to 100): measure after the transition.
  for (let i = 0; i < n; i++) {
    await expect.poll(async () => (await more.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
    expect((await more.nth(i).boundingBox())!.width).toBeGreaterThanOrEqual(43.5);
  }
});

Then("the branch popup search box has the value {string}", async ({ page }, v: string) => {
  await expect(popup(page).getByTestId("branch-popup-search")).toHaveValue(v);
});

When("I click outside the branch popup", async ({ page }) => {
  await page.mouse.click(5, 5);
});

Then("the branch popup is closed", async ({ page }) => {
  await expect(popup(page)).toHaveCount(0);
});
