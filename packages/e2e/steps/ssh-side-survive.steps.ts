// An SSH Side survives the pipe (GH-548, ADR 0009: the Hub of the host stays): see features/ssh-side-survive.feature. POSIX with docker and the ssh tools only.
// Shared steps (throwaway host, choose host, open project folder, Settings › Sides, close Settings) live in ssh-side.steps.ts / create-worktree.steps.ts.
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { openApp } from "../support/flow.ts";
import { openSettings } from "../support/ui.ts";
import { runDir, sshDir } from "../support/paths.ts";
import { hubPids, run } from "../support/ssh-hub.ts";
import { Then, When } from "./fixtures.ts";

const config = () => join(sshDir(runDir()), "config");
const original = () => join(sshDir(runDir()), "config.reachable");
const row = (page: Page, alias: string) => page.getByTestId(`settings-side-ssh:${alias}`);
// The host's port moved to a closed one: a new ssh (a retry of the attach) is refused, the Hub on the host is untouched.
When("the SSH host {string} becomes unreachable", async ({}, _alias: string) => {
  if (!existsSync(original())) copyFileSync(config(), original());
  writeFileSync(config(), readFileSync(original(), "utf8").replace(/^(\s*Port )(\d+)$/gm, (_m, p: string, n: string) => `${p}${Number(n) + 1}`));
});

When("the SSH host {string} becomes reachable again", async ({}, _alias: string) => {
  if (!existsSync(original())) return;
  copyFileSync(original(), config());
  rmSync(original()); // a later repeat runs on a new host and port: a stale copy would restore a dead port
});

// The Hub's ssh process of the host: its command line holds the run's config path and the alias after `--`.
When("I kill the Hub's ssh process of the SSH host {string}", async ({}, alias: string) => {
  const pids = run("pgrep", ["-f", `ssh .*-F ${config()} -- ${alias}`]).split(/\s+/).filter(Boolean);
  expect(pids.length, "the Hub's ssh process of the host").toBeGreaterThan(0);
  for (const p of pids) process.kill(Number(p), "SIGKILL");
});

Then("the Settings row of the SSH host {string} says {string}", async ({ page }, alias: string, text: string) => {
  await row(page, alias).scrollIntoViewIfNeeded();
  await expect(row(page, alias)).toContainText(text, { timeout: 90_000 });
});

Then("the Hub of the SSH host is still running", async ({ sshHost }) => {
  const host = await sshHost.get();
  expect(hubPids(host.name).length, "Hubs in the host").toBe(1);
});

When("I reload the app and the daemon restarts and I open Settings › Sides", async ({ page, daemon }) => {
  await daemon.restart();
  await openApp(page, daemon);
  await openSettings(page);
  await page.getByTestId("settings-group-sides").click();
  await expect(page.getByTestId("settings-sides")).toBeVisible();
});
