// GH-679: the OpenCode model picker's list and footer.
import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

/** The popup of the model chooser: the listbox that holds the footer buttons or the group. */
const group = (page: Page, name: string) => page.getByRole("group").filter({ hasText: name }).last();

Then("the group {string} of the model chooser lists a model matching {string}", async ({ page }, name: string, text: string) => {
  const g = group(page, name);
  await expect(g.getByRole("option").filter({ hasText: new RegExp(text, "i") }).first()).toBeVisible({ timeout: 60_000 });
});

Then("the model chooser footer offers {string}", async ({ page }, label: string) => {
  await expect(page.getByTestId("models-connect")).toContainText(label);
  await expect(page.getByTestId("models-connect")).toBeVisible();
});

Then("the model chooser footer has no error", async ({ page }) => {
  await expect(page.getByTestId("models-retry")).toHaveCount(0);
});

When("I click {string} in the model chooser footer", async ({ page }, label: string) => {
  await page.getByTestId("models-connect").filter({ hasText: label }).click();
});

Then("the model chooser footer button {string} is at least 44px high", async ({ page }, label: string) => {
  const box = await page.getByTestId("models-connect").filter({ hasText: label }).boundingBox();
  expect(box, "footer button has a box").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});

Then("every model chooser option is at least 44px high", async ({ page }) => {
  const options = page.getByRole("listbox").filter({ has: page.getByTestId("models-connect") }).getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);
  for (const o of await options.all()) expect(await o.evaluate((n) => (n as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
});
