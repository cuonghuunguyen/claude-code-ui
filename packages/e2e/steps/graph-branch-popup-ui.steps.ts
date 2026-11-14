import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const popup = (page: Page) => page.getByTestId("branch-popup");
const sub = (page: Page) => page.getByTestId("branch-popup-sub");
const menu = (page: Page) => page.getByTestId("branch-menu");
const items = (p: ReturnType<typeof menu>) => p.getByRole("menuitem");

// Red = the destructive token: its computed colour has a clearly larger red than green and blue channel.
const isRed = async (el: ReturnType<Page["locator"]>) => {
  const [r, g, b] = (await el.evaluate((n) => getComputedStyle(n).color)).match(/[\d.]+/g)!.map(Number);
  return r > 120 && r > g * 1.5 && r > b * 1.5;
};

Then("the branch popup marks the current branch", async ({ page }) => {
  await expect(popup(page).locator('[aria-label="Current branch"]')).toHaveCount(1);
});

Then("the branch popup highlights the match {string}", async ({ page }, q: string) => {
  const m = popup(page).locator("mark");
  await expect(m.first()).toBeVisible();
  expect((await m.first().textContent())!.toLowerCase()).toBe(q);
});

Then("the branch popup actions show {string} in red", async ({ page }, name: string) => {
  const it = sub(page).getByRole("menuitem", { name: new RegExp(`^${name}`) });
  await expect(it).toHaveCount(1);
  expect(await isRed(it)).toBe(true);
});

Then("the commit menu shows {string} in red", async ({ page }, name: string) => {
  const it = items(menu(page)).filter({ hasText: name });
  await expect(it).toHaveCount(1);
  expect(await isRed(it)).toBe(true);
});

Then("the branch popup search box is hidden", async ({ page }) => {
  await expect(popup(page).getByTestId("branch-popup-search")).toBeHidden();
});

Then("the branch popup search box has focus", async ({ page }) => {
  await expect(popup(page).getByTestId("branch-popup-search")).toBeFocused();
});

Then("the branch popup actions are closed", async ({ page }) => {
  await expect(sub(page)).toHaveCount(0);
});

When("I click the {string} header of the branch popup", async ({ page }, name: string) => {
  await popup(page).getByTestId("branch-popup-row").filter({ hasText: new RegExp(`^${name}$`) }).click();
});

Then("the active branch popup row is {string}", async ({ page }, name: string) => {
  const input = popup(page).getByTestId("branch-popup-search");
  const id = await input.getAttribute("aria-activedescendant");
  await expect(page.locator(`[id="${id}"]`)).toHaveText(name);
});

Then("the commit menu lists in order {string}", async ({ page }, list: string) => {
  const want = list.split(", ");
  const it = items(menu(page));
  await expect(it).toHaveCount(want.length);
  for (let i = 0; i < want.length; i++) await expect(it.nth(i)).toContainText(want[i]!);
  // Order, not only presence: each prefix is the start of the item's text.
  for (let i = 0; i < want.length; i++) expect((await it.nth(i).innerText()).trim().startsWith(want[i]!)).toBe(true);
});

Then("the commit menu has no {string}", async ({ page }, text: string) => {
  await expect(menu(page).getByText(text)).toHaveCount(0);
});

Then("the branch chip menu offers {string}", async ({ page }, name: string) => {
  await expect(items(menu(page)).filter({ hasText: new RegExp(`^${name}`) })).toHaveCount(1);
});

Then("the branch chip menu does not offer {string}", async ({ page }, name: string) => {
  await expect(items(menu(page)).filter({ hasText: new RegExp(`^${name}`) })).toHaveCount(0);
});

// A closing menu stays in the DOM during its exit animation: wait for it before the next menu opens.
Then("the branch menu is closed", async ({ page }) => {
  await expect(menu(page)).toHaveCount(0);
});

// Phone: the row's author column is hidden, so the right click goes on the subject text.
When("I open the commit menu on the subject {string}", async ({ page }, subject: string) => {
  await page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first().getByText(subject, { exact: true }).click({ button: "right" });
  await expect(menu(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("commit-revert")).toBeVisible({ timeout: 30_000 });
});
