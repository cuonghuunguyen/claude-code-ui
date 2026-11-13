import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { promptBox } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const menu = (page: Page) => page.getByTestId("selection-menu");

Given("the scratch project has the five-line file {string}", async ({ project }, rel: string) => {
  writeFileSync(join(project.path, rel), Array.from({ length: 5 }, (_, i) => `const row${i + 1} = ${i + 1};`).join("\n") + "\n");
});

When("I click {string} in the selection menu", async ({ page }, name: string) => {
  await menu(page).getByRole("button", { name, exact: true }).click();
});

Then("the selection menu offers {string} and {string}", async ({ page }, a: string, b: string) => {
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByTestId("selection-menu-add")).toHaveText(a);
  await expect(menu(page).getByTestId("selection-menu-quote")).toHaveText(b);
});

Then("no button is named like {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("button", { name: new RegExp(text, "i") })).toHaveCount(0);
});

Then("the selection menu text does not mention {string}", async ({ page }, word: string) => {
  expect(((await menu(page).innerText()) + (await menu(page).getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? "").join(" ")))).toLowerCase()).not.toContain(word.toLowerCase());
});

Then("the selection menu is absent", async ({ page }) => {
  await expect(menu(page)).toHaveCount(0);
});

Then("the prompt box has a quoted block", async ({ page }) => {
  await expect.poll(() => promptBox(page).inputValue()).toMatch(/^> ```/m);
});

Then("the prompt box has a file mention with a line range", async ({ page }) => {
  await expect.poll(() => promptBox(page).inputValue()).toMatch(/@\S+#L\d+-\d+/);
});

When("I select two full lines of the Files editor", async ({ page }) => {
  await page.getByTestId("files-panel").locator(".cm-line").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
});

Given("the pointer is coarse", async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
});

When("I click once in the Files editor", async ({ page }) => {
  await page.getByTestId("files-panel").locator(".cm-line").nth(2).click();
});

Then("the selection menu buttons are at least 44px high", async ({ page }) => {
  await expect(menu(page)).toBeVisible();
  const buttons = menu(page).getByRole("button");
  expect(await buttons.count()).toBeGreaterThanOrEqual(2);
  for (const h of await buttons.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(h).toBeGreaterThanOrEqual(44);
});

Then("the selection menu is below the selected diff rows", async ({ page }) => {
  await expect(menu(page)).toBeVisible();
  const menuTop = (await menu(page).boundingBox())!.y;
  const rows = page.getByTestId("changes-panel").getByTestId("file-diff").locator("[data-selected-line]");
  const bottoms = await rows.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().bottom));
  expect(bottoms.length).toBeGreaterThan(0);
  expect(menuTop).toBeGreaterThanOrEqual(Math.max(...bottoms) - 0.5);
});
