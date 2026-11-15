import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { configHome, runDir } from "../support/paths.ts";
import { openSettings } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const t = (page: Page, id: string) => page.getByTestId(id);
const row = (page: Page, name: string) => t(page, "settings-opencode-connect-row").filter({ hasText: name });
const connected = (page: Page, name: string) => t(page, "settings-opencode-provider-row").filter({ hasText: name });

Given("OpenCode has the fake login plugin and no saved login", async ({ $test }) => {
  $test.skip(!process.env.E2E_OPENCODE_BIN, "E2E_OPENCODE_BIN is not set");
  const run = runDir();
  const dir = join(configHome(run), "opencode", "plugins");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "../support/fake-opencode-auth.js"), join(dir, "fake-opencode-auth.js"));
  rmSync(join(run, "opencode-data", "opencode", "auth.json"), { force: true });
  // The run's config is shared by its scenarios: an earlier OpenCode session left OpenCode as the new-session Engine, whose tab starts the server,
  // so "Show providers" (stopped server) never shows. Back to Claude before the scenario's daemon starts.
  const file = join(configHome(run), "claude-ui", "settings.json");
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s.sessions?.engine) writeFileSync(file, JSON.stringify({ ...s, sessions: { ...s.sessions, engine: "claude" } }));
  }
});

When("I open Settings › OpenCode", async ({ page }) => {
  await openSettings(page);
  await t(page, "settings-group-opencode").click();
  await expect(t(page, "settings-opencode")).toBeVisible();
});

When("I show the OpenCode providers", async ({ page }) => {
  // The status answers a moment after the section shows: the block is either the button or, with a running server, already the list.
  const load = t(page, "settings-opencode-providers-load");
  await expect(load.or(t(page, "settings-opencode-connect-search"))).toBeVisible();
  if (await load.isVisible()) await load.click();
  await expect(t(page, "settings-opencode-connect-search")).toBeVisible({ timeout: 60_000 });
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

When("I type the API key {string} and connect", async ({ page }, key: string) => {
  await t(page, "settings-opencode-key").fill(key);
  await t(page, "settings-opencode-login-submit").click();
});

Then("the provider {string} is connected with the status {string}", async ({ page }, name: string, status: string) => {
  const r = connected(page, name);
  await expect(r).toBeVisible({ timeout: 30_000 });
  // The fake plugin hands back a key, which OpenCode stores as an API credential: "Connected · API key" also starts with "Connected".
  await expect(r.getByTestId("settings-opencode-provider-status")).toContainText(status);
});

Then("the OpenCode providers say {string}", async ({ page }, text: string) => {
  await expect(t(page, "settings-opencode-providers-message")).toHaveText(text);
});
