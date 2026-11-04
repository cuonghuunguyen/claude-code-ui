// GH-547: see features/ssh-hosts.feature. Needs no docker: the ssh config is a file of the run folder.
import { expect } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDir, sshDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";

Given("an ssh config with an Include and patterns", async ({ daemon }) => {
  void daemon; // the daemon of the worker reads CLAUDE_UI_SSH_CONFIG on every list
  const dir = sshDir(runDir());
  mkdirSync(join(dir, "conf.d"), { recursive: true });
  writeFileSync(
    join(dir, "config"),
    ["Host main-a", "  HostName 127.0.0.1", "Host *", "  LogLevel ERROR", "Host wild-* !neg-y", "  User x", `Include ${join(dir, "conf.d", "*.conf")}`, "Host inc-b", "  HostName 127.0.0.2", ""].join("\n"),
  );
  writeFileSync(join(dir, "conf.d", "a.conf"), ["Host inc-b inc-c", "  HostName 127.0.0.3", "Host *.wild", "Host !neg-y", ""].join("\n"));
  // The daemon throttles host discovery to one run per 5 s: a config written right after its start would be read by the next refresh only.
  await new Promise((r) => setTimeout(r, 5_200));
});

const rows = (page: import("@playwright/test").Page, alias: string) => page.getByTestId("container-row").filter({ has: page.getByText(alias, { exact: true }) });

Then("the SSH host list shows {string} once", async ({ page }, alias: string) => {
  await expect(rows(page, alias)).toHaveCount(1, { timeout: 30_000 });
});

Then("the SSH host list does not show {string}", async ({ page }, alias: string) => {
  await expect(page.getByTestId("container-row").first()).toBeVisible();
  await expect(rows(page, alias)).toHaveCount(0);
});

When("I open the Add SSH host form", async ({ page }) => {
  await page.getByTestId("add-ssh-host").click();
  await expect(page.getByTestId("add-ssh-host-form")).toBeVisible();
});

When("I add the SSH host with the command {string} and the alias {string}", async ({ page }, command: string, alias: string) => {
  await page.getByTestId("add-ssh-host-command").fill(command);
  await page.getByTestId("add-ssh-host-alias").fill(alias);
  await page.getByTestId("add-ssh-host-submit").click();
});

Then("the Add SSH host form says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("add-ssh-host-error")).toContainText(text);
});

Then("the form fits the viewport", async ({ page }) => {
  const box = await page.getByTestId("add-ssh-host-form").boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box && box.x >= 0 && box.x + box.width <= vw, `form box ${JSON.stringify(box)} in ${vw}`).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

Then("the ssh config has a Host block {string} with {string}", async ({}, alias: string, line: string) => {
  const text = readFileSync(join(sshDir(runDir()), "config"), "utf8");
  const i = text.indexOf(`Host ${alias}\n`);
  expect(i, text).toBeGreaterThanOrEqual(0);
  expect(text.slice(i)).toContain(line);
});
