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
  // The popup zooms in (100ms): a box measured mid-animation is scaled below its layout size. Wait until it settles.
  const button = page.getByTestId("models-connect").filter({ hasText: label });
  await expect.poll(async () => (await button.boundingBox())?.height ?? 0, { timeout: 3000 }).toBeGreaterThanOrEqual(44);
});

Then("every model chooser option is at least 44px high", async ({ page }) => {
  const options = page.locator('[data-slot="select-content"]').filter({ has: page.getByTestId("models-connect") }).getByRole("option");
  expect(await options.count()).toBeGreaterThan(1);
  for (const o of await options.all()) expect(await o.evaluate((n) => (n as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(44);
});

Then("the model chooser has at least {int} options", async ({ page }, n: number) => {
  const options = page.locator('[data-slot="select-content"]').filter({ has: page.getByTestId("models-connect") }).getByRole("option");
  expect(await options.count()).toBeGreaterThanOrEqual(n);
});

Then("the model chooser footer is visible inside the viewport without scrolling the list", async ({ page }) => {
  const m = await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="models-connect"]') as HTMLElement | null;
    const popup = footer?.closest('[data-slot="select-content"]') as HTMLElement | null;
    if (!footer || !popup) return null;
    const f = footer.getBoundingClientRect();
    const p = popup.getBoundingClientRect();
    return {
      scrollTop: popup.scrollTop,
      scrollable: popup.scrollHeight > popup.clientHeight,
      footerTop: f.top, footerBottom: f.bottom, footerLeft: f.left, footerRight: f.right,
      popupTop: p.top, popupBottom: p.bottom,
      vw: window.innerWidth, vh: window.innerHeight,
    };
  });
  expect(m, "footer button inside a select popup").not.toBeNull();
  expect(m!.scrollTop, "the list is not scrolled").toBe(0);
  expect(m!.footerTop).toBeGreaterThanOrEqual(m!.popupTop);
  expect(m!.footerBottom).toBeLessThanOrEqual(m!.popupBottom + 1);
  expect(m!.footerTop).toBeGreaterThanOrEqual(0);
  expect(m!.footerBottom).toBeLessThanOrEqual(m!.vh);
  expect(m!.footerLeft).toBeGreaterThanOrEqual(0);
  expect(m!.footerRight).toBeLessThanOrEqual(m!.vw);
  console.log("footer-metrics", JSON.stringify(m));
});
