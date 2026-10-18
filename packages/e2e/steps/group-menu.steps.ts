import { expect, type Page } from "@playwright/test";
import { Given, Then, When, type Project } from "./fixtures.ts";

// The chip of this scenario's project: earlier scenarios' sessions may still be open tabs on the shared daemon.
const chipOf = (page: Page, project: Project) => page.locator(`[data-testid="tab-group-chip"][data-group-chip*="${project.name}"]`);
const ACTIONS = ["tab-group-cleanup", "tab-group-close-others", "tab-group-close"];

// Compact tabs is a per-browser setting (localStorage); seeded before the app loads, as a returning user who switched it on.
Given("compact tab groups are on", async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("claude-ui.tabCompact", "1");
    } catch {}
  });
});

When("I hover the group chip", async ({ page, project }) => {
  await chipOf(page, project).hover();
  await expect(page.getByTestId("tab-group-menu")).toBeVisible();
});

When("I click the group chip", async ({ page, project }) => {
  // A hover may have opened the menu already and a click would close it: leave first.
  await page.mouse.move(700, 500);
  await expect(page.getByTestId("tab-group-menu")).toHaveCount(0);
  await chipOf(page, project).click();
  await expect(page.getByTestId("tab-group-menu")).toBeVisible();
});

When("I right click the group chip", async ({ page, project }) => {
  await chipOf(page, project).click({ button: "right" });
  await expect(page.getByTestId("tab-group-context-menu")).toBeVisible();
});

When("I choose {string} in the group context menu", async ({ page }, name: string) => {
  await page.getByTestId("tab-group-context-menu").getByRole("menuitem", { name }).click();
});

Then("the group menu lists the group's tab rows", async ({ page }) => {
  await expect(page.getByTestId("tab-group-menu")).toBeVisible();
  expect(await page.getByTestId("tab-group-tab-close").count()).toBeGreaterThan(0);
});

Then("the group menu has no Clean up, Close other groups or Close group", async ({ page }) => {
  for (const id of ACTIONS) await expect(page.getByTestId(id)).toHaveCount(0);
});

Then("the group menu has Clean up, Close other groups and Close group", async ({ page }) => {
  for (const id of ACTIONS) await expect(page.getByTestId("tab-group-menu").getByTestId(id)).toBeVisible();
});

Then("the group context menu has Move group left, Move group right, Clean up group, Close other groups and Close group", async ({ page }) => {
  const menu = page.getByTestId("tab-group-context-menu");
  for (const name of ["Move group left", "Move group right", "Clean up group", "Close other groups", "Close group"]) {
    await expect(menu.getByRole("menuitem", { name: new RegExp(`^${name}`) }).first()).toBeVisible();
  }
  await expect(menu.getByRole("menuitem", { name: /^(Expand|Collapse) group/ })).toHaveCount(0);
});

Then("the group chip is gone", async ({ page, project }) => {
  await expect(chipOf(page, project)).toHaveCount(0);
});

Then("the phone shows the tab switcher and no group chip", async ({ page }) => {
  await expect(page.getByRole("combobox", { name: "Switch tab" })).toBeVisible();
  await expect(page.getByTestId("tab-group-chip").locator("visible=true")).toHaveCount(0);
});
