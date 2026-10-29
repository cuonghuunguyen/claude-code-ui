import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { Given, Then, When } from "./fixtures.ts";

const tab = (page: Page, name: string): Locator => page.locator('[data-testid="tab"][data-tab-id^="file:"]').filter({ hasText: name });
const strip = (page: Page, name: string): Locator => tab(page, name).locator('[role="tab"]');
const body = (page: Page, name: string): Locator => page.locator(`[data-pane-tab-body^="file:"][data-pane-tab-body$="/${name}"]`);
const row = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"][data-path$="/${rel}"]`).first();
let question = "";

Given("the scratch project has the file {string} with the text {string}", async ({ project }, rel: string, text: string) => {
  const file = join(project.path, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
});

When("I delete the project file {string}", async ({ project }, rel: string) => {
  rmSync(join(project.path, rel));
});

When("I choose {string} in the tree menu of {string}", async ({ page }, label: string, rel: string) => {
  await row(page, rel).click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

When("I type {string} at the start of the Files editor", async ({ page }, text: string) => {
  const editor = page.getByTestId("files-panel").locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type(text);
});

When("I type {string} at the start of the file tab {string}", async ({ page }, text: string, name: string) => {
  const editor = body(page, name).locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type(text);
});

When("I click Open in tab in the Files header", async ({ page }) => {
  await page.getByTestId("files-panel").getByTestId("open-in-tab").click();
});

When("I save the file tab {string}", async ({ page }, name: string) => {
  await body(page, name).getByTestId("editor-save").click();
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
  page.once("dialog", (d) => {
    question = d.message();
    return answer === "accept" ? d.accept() : d.dismiss();
  });
  await tab(page, name).getByTestId("tab-close").click({ force: true });
});

When("I choose {string} in the menu of the file tab {string}", async ({ page }, label: string, name: string) => {
  await tab(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

When("I click the breadcrumb folder {string} of the file tab {string}", async ({ page }, folder: string, name: string) => {
  await body(page, name).getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name: folder, exact: true }).click();
});

When("I open the file dialog from the Read card of {string}", async ({ page }, name: string) => {
  await page.getByTestId("tool-card").filter({ hasText: name }).first().getByTestId("viewer-open").click();
  await expect(page.getByTestId("file-dialog")).toBeVisible();
});

When("I click Open in tab in the file dialog", async ({ page }) => {
  await page.getByTestId("file-dialog").getByTestId("open-in-tab").click();
});

Then("the file tab {string} opens right of its session tab with the editor focused", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveCount(1);
  await expect(strip(page, name)).toHaveAttribute("aria-selected", "true");
  const ids = await page.locator('[data-testid="tab-strip"] [data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id") ?? ""));
  const at = ids.findIndex((i) => i.startsWith("file:") && i.endsWith(`/${name}`));
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe(ids[at]!.split(":")[1]);
  await expect(body(page, name).locator(".cm-content")).toBeFocused();
});

Then("the Files editor tabs do not list {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("files-panel").getByTestId("editor-tab").filter({ hasText: name })).toHaveCount(0);
});

Then("the file tab {string} shows the unsaved mark", async ({ page }, name: string) => {
  await expect(tab(page, name)).toContainText("●");
});

Then("the file tab {string} shows no unsaved mark", async ({ page }, name: string) => {
  await expect(tab(page, name)).not.toContainText("●");
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

Then("the question was {string}", async ({}, text: string) => {
  expect(question).toBe(text);
});

Then("the Files editor shows {string} with the text {string}", async ({ page }, name: string, text: string) => {
  const files = page.getByTestId("files-panel");
  await expect(files.getByTestId("editor-tab").filter({ hasText: name })).toHaveAttribute("aria-selected", "true");
  await expect(files.locator(".cm-content")).toHaveText(text);
});

Then("the tree row {string} is shown", async ({ page }, rel: string) => {
  await expect(row(page, rel)).toBeVisible({ timeout: 30_000 });
});

Then("the Markdown preview of the file tab {string} shows {string}", async ({ page }, name: string, text: string) => {
  await expect(body(page, name).getByTestId("md-preview")).toContainText(text);
});

Then("the file tab {string} shows a read error", async ({ page }, name: string) => {
  const status = page.locator("[data-pane-tab-body^='file:']").getByTestId("file-tab-loading");
  await expect(status).toBeVisible({ timeout: 30_000 });
  await expect(status).not.toHaveText(/Loading file/);
  expect(name).toBeTruthy();
});

Then("the tab switcher lists the file row {string}", async ({ page }, name: string) => {
  await expect(page.getByRole("option").filter({ hasText: name })).toHaveCount(1);
});

Then("no file dialog shows", async ({ page }) => {
  await expect(page.getByTestId("file-dialog")).toHaveCount(0);
});
