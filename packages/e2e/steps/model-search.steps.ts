// GH-680: the search field of the model picker (a Combobox popup from 8 models).
import { expect, type Page } from "@playwright/test";
import { Then, When } from "./fixtures.ts";

const search = (page: Page) => page.getByTestId("model-search");
const options = (page: Page) => page.getByRole("option");
const trigger = (page: Page) => page.getByTestId("session-model");
const highlighted = (page: Page) => page.locator('[role="option"][data-highlighted]');
let remembered = "";

const inViewport = async (page: Page, box: { x: number; y: number; width: number; height: number } | null, what: string) => {
  expect(box, `${what} has a box`).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x, `${what} left`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${what} top`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} right`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height, `${what} bottom`).toBeLessThanOrEqual(vp.height + 0.5);
};

Then("the model chooser has a search field above the list", async ({ page }) => {
  await expect(search(page)).toBeVisible();
  const [s, o] = [await search(page).boundingBox(), await options(page).first().boundingBox()];
  expect(s!.y + s!.height).toBeLessThanOrEqual(o!.y + 0.5);
});

Then("the model chooser has no search field", async ({ page }) => {
  await expect(options(page).first()).toBeVisible();
  await expect(search(page)).toHaveCount(0);
});

Then("the model chooser lists at least {int} models", async ({ page }, n: number) => {
  expect(await options(page).count()).toBeGreaterThanOrEqual(n);
});

When("I search the model chooser for {string}", async ({ page }, text: string) => {
  await search(page).fill(text);
});

Then("every listed model matches {string}", async ({ page }, text: string) => {
  await expect(options(page).first()).toBeVisible();
  await expect.poll(async () => (await options(page).allTextContents()).filter((t) => !new RegExp(text, "i").test(t)).length).toBe(0);
  expect(await options(page).count()).toBeGreaterThan(0);
});

Then("the model chooser shows only the groups {string}", async ({ page }, names: string) => {
  await expect.poll(async () => (await page.locator('[data-slot="select-label"]').allTextContents()).map((s) => s.trim())).toEqual(names.split(", "));
});

Then("the model chooser says {string}", async ({ page }, text: string) => {
  await expect(page.getByText(text, { exact: true })).toBeVisible();
});

Then("the model chooser lists no model", async ({ page }) => {
  await expect(options(page)).toHaveCount(0);
});

Then("the model search field has the focus", async ({ page }) => {
  await expect(search(page)).toBeFocused();
});

When("I type {string} without clicking the field", async ({ page }, text: string) => {
  await page.keyboard.type(text);
  await expect(search(page)).toHaveValue(text);
});

When("I press {string} in the model chooser", async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

Then("a listed model is highlighted", async ({ page }) => {
  await expect(highlighted(page)).toHaveCount(1);
  remembered = ((await highlighted(page).textContent()) ?? "").trim();
  expect(remembered).toMatch(/deepseek/i);
});

Then("the model chooser is closed", async ({ page }) => {
  await expect(search(page)).toHaveCount(0);
  await expect(page.getByRole("listbox")).toHaveCount(0);
});

Then("the toolbar shows the model that was highlighted", async ({ page }) => {
  await expect(trigger(page)).toContainText(remembered);
});

Then("the model search field is visible inside the viewport", async ({ page }) => {
  await expect(search(page)).toBeVisible();
  await inViewport(page, await search(page).boundingBox(), "search field");
});

Then("the model chooser footer is visible inside the viewport", async ({ page }) => {
  const f = page.getByTestId("models-connect");
  await expect(f).toBeVisible();
  await inViewport(page, await f.boundingBox(), "footer");
});

Then("the model search field is at least {int}px high", async ({ page }, n: number) => {
  expect(await search(page).evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(n);
});

Then("every model option is at least {int}px high", async ({ page }, n: number) => {
  const all = await options(page).all();
  expect(all.length).toBeGreaterThan(1);
  for (const o of all) expect(await o.evaluate((e) => (e as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(n);
});

When("I pick another model in the model chooser", async ({ page }) => {
  const all = await options(page).all();
  for (const o of all) {
    if ((await o.getAttribute("aria-selected")) !== "true") {
      remembered = ((await o.textContent()) ?? "").trim();
      await o.click();
      return;
    }
  }
  throw new Error("only one model in the list");
});

Then("the toolbar shows the model that was picked", async ({ page }) => {
  await expect(trigger(page)).toContainText(remembered.slice(0, 8));
});

// A cold OpenCode lists only "default" at first; the picker is then a plain list, and it is rebuilt with the search field when the models arrive
// (the open popup closes). The user's next click opens the full picker: this step is that click, repeated until the search field is there.
When("I open the model chooser once the models have loaded", async ({ page }) => {
  await expect(async () => {
    const settings = page.getByTestId("session-settings");
    if ((await settings.isVisible()) && !(await trigger(page).isVisible())) await settings.click();
    if (!(await search(page).isVisible()) && (await trigger(page).getAttribute("aria-expanded")) !== "true") await trigger(page).click();
    await expect(search(page)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
});
