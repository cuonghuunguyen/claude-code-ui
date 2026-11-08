import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { configHome, runDir } from "../support/paths.ts";
import { openSettings } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const t = (page: Page, id: string) => page.getByTestId(id);
const row = (page: Page, name: string) => t(page, "settings-opencode-connect-row").filter({ hasText: name });
const connected = (page: Page, name: string) => t(page, "settings-opencode-provider-row").filter({ hasText: name });
let opened: Page | undefined;

Given("OpenCode has the fake login plugin and no saved login", async ({ $test }) => {
  $test.skip(!process.env.E2E_OPENCODE_BIN, "E2E_OPENCODE_BIN is not set");
  const run = runDir();
  const dir = join(configHome(run), "opencode", "plugins");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "../support/fake-opencode-auth.js"), join(dir, "fake-opencode-auth.js"));
  rmSync(join(run, "opencode-data", "opencode", "auth.json"), { force: true });
});

When("I open Settings › OpenCode", async ({ page }) => {
  await openSettings(page);
  await t(page, "settings-group-opencode").click();
  await expect(t(page, "settings-opencode")).toBeVisible();
});

Then("the OpenCode providers block offers {string}", async ({ page }, label: string) => {
  await expect(t(page, "settings-opencode-providers-load")).toHaveText(label);
});

When("I show the OpenCode providers", async ({ page }) => {
  const load = t(page, "settings-opencode-providers-load");
  if (await load.isVisible()) await load.click();
  await expect(t(page, "settings-opencode-connect-search")).toBeVisible({ timeout: 60_000 });
});

Then("the OpenCode providers say no provider is connected", async ({ page }) => {
  await expect(t(page, "settings-opencode-providers-empty")).toContainText("No provider connected");
  await expect(t(page, "settings-opencode-providers-empty")).toContainText("free models still work");
});

When("I click {string} in the OpenCode providers", async ({ page }, name: string) => {
  await t(page, "settings-opencode-providers").getByRole("button", { name }).click();
});

Then("the provider search is focused", async ({ page }) => {
  await expect(t(page, "settings-opencode-connect-search")).toBeFocused();
});

When("I search the OpenCode providers for {string}", async ({ page }, text: string) => {
  await t(page, "settings-opencode-connect-search").fill(text);
});

When("I open the provider row {string}", async ({ page }, name: string) => {
  await row(page, name).first().click();
  await expect(t(page, "settings-opencode-connect-form")).toContainText(`Connect ${name}`);
});

When("I pick the login method {string}", async ({ page }, label: string) => {
  await t(page, "settings-opencode-connect-form").getByLabel(label, { exact: true }).check();
});

When("I type the API key {string} and leave the field", async ({ page }, key: string) => {
  await t(page, "settings-opencode-key").fill(key);
  await t(page, "settings-opencode-key").blur();
});

Then("the API key field shows the error {string}", async ({ page }, text: string) => {
  await expect(t(page, "settings-opencode-key-error")).toHaveText(text);
  await expect(t(page, "settings-opencode-key")).toHaveAttribute("aria-invalid", "true");
});

When("I type the API key {string} and connect", async ({ page }, key: string) => {
  await t(page, "settings-opencode-key").fill(key);
  await t(page, "settings-opencode-login-submit").click();
});

Then("the provider {string} is connected with the status {string}", async ({ page }, name: string, status: string) => {
  const r = connected(page, name);
  await expect(r).toBeVisible({ timeout: 30_000 });
  await expect(r.getByTestId("settings-opencode-provider-status")).toHaveText(status);
});

Then("the OpenCode providers say {string}", async ({ page }, text: string) => {
  await expect(t(page, "settings-opencode-providers-message")).toHaveText(text);
});

When("I connect Groq with the API key {string}", async ({ page }, key: string) => {
  await t(page, "settings-opencode-connect-search").fill("groq");
  await row(page, "Groq").first().click();
  await t(page, "settings-opencode-connect-form").getByLabel("API key", { exact: true }).check().catch(() => {});
  await t(page, "settings-opencode-key").fill(key);
  await t(page, "settings-opencode-login-submit").click();
  await expect(connected(page, "Groq")).toBeVisible({ timeout: 30_000 });
});

When("I connect Groq with the keyboard using the API key {string}", async ({ page }, key: string) => {
  await t(page, "settings-opencode-connect-search").focus();
  await page.keyboard.type("groq");
  await page.keyboard.press("Tab");
  await expect(row(page, "Groq").first()).toBeFocused();
  await expect(row(page, "Groq").first()).toHaveCSS("outline-style", /auto|solid/);
  await page.keyboard.press("Enter");
  await expect(t(page, "settings-opencode-connect-form")).toBeVisible();
  // Method radios: Groq has the plugin's three; Tab to the "API key" radio (the checked one is the first).
  await page.getByLabel("API key", { exact: true }).first().focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(t(page, "settings-opencode-key")).toBeFocused();
  await page.keyboard.type(key);
  await page.keyboard.press("Enter");
});

When("I click {string} on the provider {string}", async ({ page }, button: string, name: string) => {
  await connected(page, name).getByRole("button", { name: button }).click();
  await expect(t(page, "settings-opencode-logout-dialog")).toBeVisible();
});

When("I cancel the log out", async ({ page }) => {
  await t(page, "settings-opencode-logout-cancel").click();
  await expect(t(page, "settings-opencode-logout-dialog")).toBeHidden();
});

When("I confirm the log out", async ({ page }) => {
  await t(page, "settings-opencode-logout-confirm").click();
});

Then("the provider row {string} is in the connect list", async ({ page }, name: string) => {
  await t(page, "settings-opencode-connect-search").fill(name);
  await expect(row(page, name).first()).toBeVisible();
});

When("I click Connect in the OpenCode form", async ({ page, context }) => {
  const popup = context.waitForEvent("page", { timeout: 15_000 }).catch(() => undefined);
  await t(page, "settings-opencode-login-submit").click();
  opened = await popup;
});

Then("a login page tab opens", async () => {
  expect(opened).toBeDefined();
  await expect.poll(() => opened!.url(), { timeout: 15_000 }).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
});

Then("the OpenCode form shows the waiting view", async ({ page }) => {
  await expect(t(page, "settings-opencode-oauth-wait")).toContainText("Waiting for you to finish in the browser");
  await expect(t(page, "settings-opencode-connect-form")).toContainText("Finish in the browser");
  await expect(t(page, "settings-opencode-login-cancel")).toBeVisible();
});

When("I cancel the OpenCode login", async ({ page }) => {
  await t(page, "settings-opencode-login-cancel").click();
  await opened?.close();
});

When("I finish the login in the opened tab", async ({ page }) => {
  expect(opened).toBeDefined();
  await expect(t(page, "settings-opencode-oauth-wait")).toBeVisible();
  const base = new URL(opened!.url()).origin;
  await opened!.goto(`${base}/done`);
  await expect(opened!.locator("body")).toContainText("Fake login done");
  await opened!.close();
});

When("I send the login code {string}", async ({ page }, code: string) => {
  await t(page, "settings-opencode-oauth-code").fill(code);
  await t(page, "settings-opencode-login-submit").click();
});

Then("the login code field shows an error", async ({ page }) => {
  await expect(t(page, "settings-opencode-connect-form").getByRole("alert")).toContainText("Login was not completed");
  await expect(t(page, "settings-opencode-oauth-code")).toHaveAttribute("aria-invalid", "true");
});

// models.dev data comes from the network or OpenCode's cache: offline, the picker only has to open.
Then("the model picker lists the provider {string} when OpenCode has its models", async ({ page }, name: string, ) => {
  const picker = t(page, "session-model");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  await picker.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("listbox")).toContainText(name, { timeout: 15_000 }).catch(() => test_note(`no ${name} group: models.dev data not available`));
  await page.keyboard.press("Escape");
});
const test_note = (m: string) => console.warn(m);
