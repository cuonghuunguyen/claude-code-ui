// SSH Side survives the pipe (GH-548): see features/ssh-side-survive.feature. POSIX with docker and the ssh tools only.
// Shared steps (throwaway host, choose host, open project folder, Settings › Sides, close Settings) live in ssh-side.steps.ts / create-worktree.steps.ts.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { openApp } from "../support/flow.ts";
import { openSettings } from "../support/ui.ts";
import { runDir, sshDir } from "../support/paths.ts";
import { Then, When } from "./fixtures.ts";

const config = () => join(sshDir(runDir()), "config");
const original = () => join(sshDir(runDir()), "config.reachable");
const row = (page: Page, alias: string) => page.getByTestId(`settings-side-ssh:${alias}`);
const grace = (page: Page, alias: string) => page.getByTestId(`settings-side-grace-ssh:${alias}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
/** The Side Daemon process of the host (a node running `--side`), by its command line inside the container. */
const daemonPids = (container: string) => run("docker", ["exec", container, "pgrep", "-f", "side-daemon|--side"]).split(/\s+/).filter(Boolean);

// The host's port moved to a closed one: a new ssh (a retry of the attach) is refused, the Side Daemon on the host is untouched.
When("the SSH host {string} becomes unreachable", async ({}, _alias: string) => {
  if (!existsSync(original())) copyFileSync(config(), original());
  writeFileSync(config(), readFileSync(original(), "utf8").replace(/^(\s*Port )(\d+)$/gm, (_m, p: string, n: string) => `${p}${Number(n) + 1}`));
});

When("the SSH host {string} becomes reachable again", async ({}, _alias: string) => {
  if (existsSync(original())) copyFileSync(original(), config());
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

Then("the Side Daemon of the SSH host is still running", async ({ sshHost }) => {
  const host = await sshHost.get();
  expect(daemonPids(host.name).length, "Side Daemon processes in the host").toBeGreaterThan(0);
});

// The idle Grace period (1 minute) runs out on the host; waits up to 3 minutes for the process to be gone.
When("the Side Daemon of the SSH host ended", async ({ sshHost }) => {
  const host = await sshHost.get();
  const end = Date.now() + 180_000;
  while (daemonPids(host.name).length && Date.now() < end) await sleep(2_000);
  expect(daemonPids(host.name), "Side Daemon processes in the host after the Grace period").toEqual([]);
});

Then("the Grace period of the SSH host {string} shows {string}", async ({ page }, alias: string, value: string) => {
  await grace(page, alias).scrollIntoViewIfNeeded();
  await expect(grace(page, alias)).toHaveValue(value, { timeout: 30_000 });
});

When("I set the Grace period of the SSH host {string} to {string}", async ({ page }, alias: string, value: string) => {
  await grace(page, alias).fill(value);
  await grace(page, alias).press("Enter");
  await expect(grace(page, alias)).toHaveValue(value);
});

When("I reload the app and the daemon restarts and I open Settings › Sides", async ({ page, daemon }) => {
  await daemon.restart();
  await openApp(page, daemon);
  await openSettings(page);
  await page.getByTestId("settings-group-sides").click();
  await expect(page.getByTestId("settings-sides")).toBeVisible();
});

let noted: string[] = [];
When("I note the Side Daemon of the SSH host", async ({ sshHost }) => {
  noted = daemonPids((await sshHost.get()).name);
  expect(noted.length).toBeGreaterThan(0);
});

Then("the Side Daemon of the SSH host is a new one", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  await expect.poll(() => daemonPids(name).filter((p) => !noted.includes(p)).length, { timeout: 60_000 }).toBeGreaterThan(0);
});

// The dialog opens on the last chosen host: an off Side starts by itself, as for any open of an installed host.
When("I open Open project on the last chosen host", async ({ page }) => {
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("open-project").click();
  await expect(page.getByTestId("open-project-dialog")).toBeVisible();
});

Then("the Open project folder input is shown", async ({ page }) => {
  await expect(page.getByTestId("folder-input")).toBeVisible({ timeout: 240_000 });
});
