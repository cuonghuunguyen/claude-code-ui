import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const popup = (page: Page) => page.getByTestId("branch-popup");
const row = (page: Page, name: string) => popup(page).getByTestId("branch-popup-row").filter({ has: page.getByText(name, { exact: true }) });

When("I open the Graph branch popup", async ({ page }) => {
  await page.getByTestId("graph-panel").getByTestId("graph-filter-branch").click();
  await expect(popup(page)).toBeVisible({ timeout: 30_000 });
  // The pointer would stay over the spot of the click, and the popup's rows can appear or move under it (filter, viewport change):
  // a mouse pointerenter opens that row's actions pane, so a scenario would depend on timing. Park the pointer outside the popup.
  await page.mouse.move(0, 0);
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
  // A pointer left over a row re-opens that row's actions pane after Escape closes it; keep the keys the only input.
  await page.mouse.move(0, 0);
  await page.keyboard.press(key);
});

When("I press {string} in the branch popup actions", async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

Then("the Graph branch filter shows {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("graph-panel").getByTestId("graph-filter-branch")).toHaveText(name);
});

When("I open the actions of the branch {string} in the branch popup", async ({ page }, name: string) => {
  const sub = page.getByTestId("branch-popup-sub");
  // A mouse left over a row (the pointer stays where an earlier step put it) opens that row's actions as the list changes under it,
  // and on a phone the pane then replaces the list, so the button is gone: accept the open pane when it is this branch's.
  const r = row(page, name);
  try {
    await r.hover({ timeout: 3000 });
    await r.getByTestId("branch-popup-more").click({ timeout: 3000 });
  } catch {
    // The HEAD row's pane is labelled "HEAD (main)" and offers the same actions as the "main" row.
    await expect(sub).toHaveAttribute("aria-label", new RegExp(`^(HEAD \\()?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)?$`));
  }
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
