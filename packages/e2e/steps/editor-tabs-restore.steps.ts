import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { waitConnected } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const files = (page: Page): Locator => page.getByTestId("files-panel");
const tab = (page: Page, name: string): Locator => files(page).getByTestId("editor-tab").filter({ hasText: name });

/** In the drawer layout the opened tree covers the editor: close it first. */
async function closeTreeDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId("file-tree-drawer");
  if (await drawer.isVisible()) {
    await page.getByTestId("toggle-tree").click();
    await expect(drawer).toBeHidden();
  }
}

When("I double click the Files editor tab {string}", async ({ page }, name: string) => {
  await tab(page, name).dblclick();
});

When("I click the Files editor tab {string}", async ({ page }, name: string) => {
  await tab(page, name).click();
});

When("I reload the page and accept the leave dialog", async ({ page }) => {
  // A dirty tab asks before the page unloads.
  page.once("dialog", (d) => void d.accept());
  await page.reload();
  await waitConnected(page);
});

When("I change the project file {string} to {string}", async ({ project }, rel: string, text: string) => {
  writeFileSync(join(project.path, rel), text);
});

When("I save the Files editor", async ({ page }) => {
  await closeTreeDrawer(page);
  await files(page).getByTestId("editor-save").click();
});

When("I click Reload from disk in the Files editor", async ({ page }) => {
  await closeTreeDrawer(page);
  await files(page).getByRole("button", { name: "Reload from disk" }).click();
});

Then("the Files editor tabs are {string}", async ({ page }, names: string) => {
  const want = names.split(",").map((n) => n.trim());
  await expect(files(page).getByTestId("editor-tab")).toHaveCount(want.length, { timeout: 30_000 });
  const got = await files(page).getByTestId("editor-tab").evaluateAll((els) => els.map((e) => (e.getAttribute("title") ?? "").split("/").pop()));
  expect(got).toEqual(want);
});

Then("the Files editor tab {string} is active", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
});

Then("the Files editor tab {string} is a preview tab", async ({ page }, name: string) => {
  await expect(tab(page, name).locator(".italic").first()).toBeVisible();
});

Then("the Files editor tab {string} shows the unsaved mark", async ({ page }, name: string) => {
  await expect(tab(page, name)).toContainText("●");
});

Then("the Files editor tab {string} shows no unsaved mark", async ({ page }, name: string) => {
  await expect(tab(page, name)).not.toContainText("●");
});

Then("the Files editor shows the conflict bar", async ({ page }) => {
  await expect(files(page).getByText("Changed on disk while you have unsaved edits.")).toBeVisible();
});

Then("the Files editor shows the line {string}", async ({ page }, text: string) => {
  await expect(files(page).getByText(text)).toBeVisible();
});

Then("the Files editor shows no error line", async ({ page }) => {
  await expect(files(page).locator("p.text-destructive")).toHaveCount(0);
});

Then("the project file {string} has the text {string}", async ({ project }, rel: string, text: string) => {
  await expect.poll(() => readFileSync(join(project.path, rel), "utf8"), { timeout: 30_000 }).toBe(text);
});
