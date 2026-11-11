import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { openSettings } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

// GH-517. Playwright mouse moves are pointerType "mouse" with buttons 0, as a real mouse.
const strokes = async (page: Page, xs: number[], gap = 0) => {
  await page.mouse.move(600, 450);
  for (const x of xs) {
    await page.mouse.move(x, 450, { steps: 2 });
    if (gap) await page.waitForTimeout(gap);
  }
};
const SHAKE = [720, 600, 720, 600, 720, 600];
const groupOf = (page: Page, project: string) => page.getByTestId("session-group").filter({ has: page.locator(`[data-testid="group-toggle"][title$="${project}"]`) });
const ringed = (page: Page) => page.locator("[data-locate]");
const activeTab = (page: Page) => page.locator('[data-testid="tab-strip"] [data-testid="tab"][data-active]');

When("I shake the mouse", async ({ page }) => strokes(page, SHAKE));
When("I wait {int} seconds", async ({ page }, s: number) => page.waitForTimeout(s * 1000));

When("I shake the mouse with the button held", async ({ page }) => {
  await page.mouse.move(600, 450);
  await page.mouse.down();
  for (const x of SHAKE) await page.mouse.move(x, 450, { steps: 2 });
  await page.mouse.up();
});

Given("the scratch project has {int} files in the folder {string}", async ({ project }, n: number, dir: string) => {
  mkdirSync(join(project.path, dir), { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(join(project.path, dir, `file-number-${i}.ts`), `export const n${i} = ${i};`);
});

When("I open every file of the folder {string} in its own tab", async ({ page, project }, dir: string) => {
  for (const f of readdirSync(join(project.path, dir)).sort()) {
    await page.locator(`[data-testid="tree-entry"][data-path$="/${dir}/${f}"]`).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Open in tab", exact: true }).click();
    await expect(page.locator(`[data-testid="tab"][data-tab-id^="file:"]`).filter({ hasText: f })).toBeVisible();
  }
});

When("I select the first session tab of the strip", async ({ page }) => {
  const first = page.locator('[data-testid="tab-strip"] [data-testid="tab"]:not([data-tab-id^="file:"])').first();
  await first.getByRole("tab").click();
  await expect(first).toHaveAttribute("data-active", "true");
  await page.waitForTimeout(1500); // let the smooth reveal scroll and any late tab activation settle
});

Then("the active tab is scrolled out of the strip", async ({ page }) => {
  // The strip scrolls when the tabs overflow; selecting the first tab leaves it at the left edge, so scroll the strip to the far right first.
  const strip = page.getByTestId("tab-strip");
  expect(await strip.evaluate((e) => (e.scrollWidth > e.clientWidth ? "overflow" : "fits"))).toBe("overflow");
  await strip.evaluate((e) => e.scrollTo(e.scrollWidth, 0));
  await expect(activeTab(page).locator("visible=true")).not.toBeInViewport();
});

When("I hide the sidebar", async ({ page }) => page.getByTestId("tab-home").click());

When("I open Settings › Layout", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-group-layout").click();
});

When("I open the command palette", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
});

Then("the shake to locate switch is absent", async ({ page }) => {
  await expect(page.getByTestId("settings-tabs-compact")).toBeVisible();
  await expect(page.getByTestId("settings-tabs-shake")).toHaveCount(0);
});

Then("the active tab is in view and has the locate ring", async ({ page }) => {
  const tab = activeTab(page).locator("visible=true");
  await expect(tab).toHaveAttribute("data-locate", "");
  await expect(tab).toBeInViewport({ ratio: 0.9 });
});
Then("the active sidebar row is in view and has the locate ring", async ({ page }) => {
  const row = page.locator('[data-testid="session-item"][aria-current="page"]');
  await expect(row).toHaveAttribute("data-locate", "");
  await expect(row).toBeInViewport();
});
Then("the outline of the ringed element is drawn", async ({ page }) => {
  const o = await ringed(page).first().evaluate((e) => ({ s: getComputedStyle(e).outlineStyle, w: getComputedStyle(e).outlineWidth }));
  expect(o).toEqual({ s: "solid", w: "2px" });
});
Then("the locate ring is gone after 2 seconds", async ({ page }) => expect(ringed(page)).toHaveCount(0, { timeout: 3000 }));
Then("nothing has the locate ring", async ({ page }) => {
  await page.waitForTimeout(400);
  await expect(ringed(page)).toHaveCount(0);
});
Then("only the tab has the locate ring", async ({ page }) => {
  await expect(page.locator('[data-testid="tab"][data-locate], [data-testid="focus-tab"][data-locate]')).toHaveCount(1);
  await expect(page.locator('[data-testid="session-item"][data-locate]')).toHaveCount(0);
});
Then("the locate ring pulses", async ({ page }) => {
  expect(await ringed(page).first().evaluate((e) => getComputedStyle(e).animationName)).toBe("locate-pulse");
});
Then("the sidebar is still hidden", async ({ page }) => expect(page.locator("aside").first()).toBeHidden());
Then("the active tab is a file tab", async ({ page }) => expect(activeTab(page).locator("visible=true")).toHaveAttribute("data-tab-id", /^file:/));