import { expect, type Page } from "@playwright/test";
import { Then } from "./fixtures.ts";

const chip = (page: Page) => page.getByTestId("project-chip");
const name = (page: Page) => page.getByTestId("new-project");

Then("the project name is cut short with an ellipsis", async ({ page }) => {
  await expect(name(page)).toBeVisible();
  const m = await name(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflow: getComputedStyle(el).textOverflow }));
  expect(m.overflow).toBe("ellipsis");
  expect(m.scroll, "the name is wider than its box").toBeGreaterThan(m.client);
});

Then("the project name is shown in full", async ({ page }) => {
  await expect(name(page)).toBeVisible();
  const m = await name(page).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(m.scroll).toBeLessThanOrEqual(m.client);
});

Then("the project chip is fully inside the viewport", async ({ page }) => {
  await expect(chip(page)).toBeVisible();
  const vw = page.viewportSize()!.width;
  const parts = [chip(page), chip(page).locator("svg").first(), chip(page).locator("svg").last(), name(page)];
  for (const p of parts) {
    const b = (await p.boundingBox())!;
    expect(b.x, "left edge").toBeGreaterThanOrEqual(0);
    expect(b.x + b.width, "right edge").toBeLessThanOrEqual(vw);
  }
  const trigger = (await chip(page).boundingBox())!;
  const chevron = (await chip(page).locator("svg").last().boundingBox())!;
  expect(chevron.x + chevron.width, "chevron inside the chip").toBeLessThanOrEqual(trigger.x + trigger.width + 0.5);
});

Then("the project chip keeps the full path as its title", async ({ page }) => {
  const title = await chip(page).getAttribute("title");
  expect(title, "a path").toMatch(/[\\/]/);
  expect(title!.length).toBeGreaterThan((await name(page).innerText()).length);
});
