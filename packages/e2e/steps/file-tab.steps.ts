import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { Given, Then, When } from "./fixtures.ts";
import { endsWithPath } from "../support/css.ts";

const tab = (page: Page, name: string): Locator => page.locator('[data-testid="tab"][data-tab-id^="file:"]').filter({ hasText: name });
const strip = (page: Page, name: string): Locator => tab(page, name).locator('[role="tab"]');
const body = (page: Page, name: string): Locator => page.locator(`[data-pane-tab-body^="file:"]${endsWithPath("data-pane-tab-body", name)}`);
const row = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"]${endsWithPath("data-path", rel)}`).first();

Given("the scratch project has the file {string} with the text {string}", async ({ project }, rel: string, text: string) => {
  const file = join(project.path, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
});

When("I choose {string} in the tree menu of {string}", async ({ page }, label: string, rel: string) => {
  await row(page, rel).click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

When("I type {string} at the start of the file tab {string}", async ({ page }, text: string, name: string) => {
  const editor = body(page, name).locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type(text);
});

When("I Quick open {string} with Alt+Enter", async ({ page }, rel: string) => {
  await page.keyboard.press("ControlOrMeta+p");
  const input = page.getByTestId("quick-open-input");
  await expect(input).toBeVisible();
  await input.fill(rel);
  await expect(page.locator(`[role="option"][data-path="${rel}"]`)).toBeVisible({ timeout: 30_000 });
  await page.locator(`[role="option"][data-path="${rel}"]`).hover();
  await input.press("Alt+Enter");
  await expect(page.getByTestId("quick-open")).toHaveCount(0);
});

When("I close the file tab {string} and {word} the question", async ({ page }, name: string, answer: string) => {
  page.once("dialog", (d) => (answer === "accept" ? d.accept() : d.dismiss()));
  await tab(page, name).getByTestId("tab-close").click({ force: true });
});

Then("the file tab {string} opens right of its session tab with the editor focused", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveCount(1);
  await expect(strip(page, name)).toHaveAttribute("aria-selected", "true");
  const ids = await page.locator('[data-testid="tab-strip"] [data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id") ?? ""));
  const at = ids.findIndex((i) => i.startsWith("file:") && (i.endsWith(`/${name}`) || i.endsWith(`\\${name}`)));
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe(ids[at]!.split(":")[1]);
  await expect(body(page, name).locator(".cm-content")).toBeFocused();
});

Then("the Files editor tabs do not list {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("files-panel").getByTestId("editor-tab").filter({ hasText: name })).toHaveCount(0);
});

Then("the file tab {string} shows the text {string}", async ({ page }, name: string, text: string) => {
  await expect(body(page, name).locator(".cm-content")).toHaveText(text, { timeout: 30_000 });
});

Then("there is one file tab {string}", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveCount(1);
});

Then("there is no file tab {string}", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveCount(0);
});

Then("the tab switcher lists the file row {string}", async ({ page }, name: string) => {
  await expect(page.getByRole("option").filter({ hasText: name })).toHaveCount(1);
});
