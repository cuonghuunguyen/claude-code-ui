// SSH Side reattach, takeover and coexistence (GH-549): see features/ssh-side-reattach.feature. POSIX with docker and the ssh tools only.
// Shared steps (throwaway host, choose host, Settings › Sides, Grace, unreachable, kill ssh) live in ssh-side.steps.ts / ssh-side-survive.steps.ts.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { openApp } from "../support/flow.ts";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { runDir, sshDir } from "../support/paths.ts";
import { openSettings } from "../support/ui.ts";
import { After, Then, When } from "./fixtures.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
const inHost = (container: string, script: string) => run("docker", ["exec", container, "sh", "-c", script]);
/** The Side Daemon processes of the host (node `--side`), sorted. */
const daemonPids = (container: string) => run("docker", ["exec", container, "pgrep", "-f", "side-daemon|--side"]).split(/\s+/).filter(Boolean).sort();
const row = (page: Page, alias: string) => page.getByTestId(`settings-side-ssh:${alias}`);

let remembered: string[] = [];
When("I remember the Side Daemon processes of the SSH host", async ({ sshHost }) => {
  remembered = daemonPids((await sshHost.get()).name);
  expect(remembered.length, "Side Daemon processes in the host").toBeGreaterThan(0);
});

Then("the Side Daemon processes of the SSH host are the remembered ones", async ({ sshHost }) => {
  expect(daemonPids((await sshHost.get()).name)).toEqual(remembered);
});

Then("no Side Daemon runs in the SSH host", async ({ sshHost }) => {
  expect(daemonPids((await sshHost.get()).name)).toEqual([]);
});

Then("the Settings row of the SSH host {string} does not say {string}", async ({ page }, alias: string, text: string) => {
  await row(page, alias).scrollIntoViewIfNeeded();
  await expect(row(page, alias)).not.toContainText(text);
});

// The Hub goes down first (its exit must not end the Side Daemon), then the Side Daemon ends, then the Hub starts: its boot attach finds none.
When("I stop the app, end the Side Daemon of the SSH host and start the app", async ({ daemon, sshHost }) => {
  const name = (await sshHost.get()).name;
  await daemon.stop();
  for (const p of daemonPids(name)) inHost(name, `kill -TERM ${p}`);
  const end = Date.now() + 30_000;
  while (daemonPids(name).length && Date.now() < end) await sleep(500);
  expect(daemonPids(name), "Side Daemon processes after the kill").toEqual([]);
  await daemon.restart();
});

// A second Hub: a daemon of this run with its own run folder (config, cache, port) and the same ssh config.
let hub2: Daemon | undefined;
let page2: Page | undefined;
When("a second Claude UI opens the SSH host {string}", async ({ page, daemon }, alias: string) => {
  const dir = join(runDir(), "hub2");
  mkdirSync(dir, { recursive: true });
  hub2 = await startDaemon(dir, 90, { port: await freePort(ownerPorts(), ""), env: { CLAUDE_UI_SSH_CONFIG: join(sshDir(runDir()), "config") } });
  expect(hub2.port).not.toBe(daemon.port);
  page2 = await page.context().newPage();
  await openApp(page2, hub2);
  await page2.getByTestId("open-project").click();
  await expect(page2.getByTestId("open-project-dialog")).toBeVisible();
  await page2.getByTestId("side-kind").filter({ hasText: "SSH" }).click({ timeout: 30_000 });
  await page2.getByTestId("container-row").filter({ hasText: alias }).click();
  await expect(page2.getByTestId("folder-input")).toBeVisible({ timeout: 240_000 });
});

Then("the second Claude UI shows the SSH host {string} as {string}", async ({}, alias: string, text: string) => {
  await page2!.keyboard.press("Escape");
  await openSettings(page2!);
  await page2!.getByTestId("settings-group-sides").click();
  await expect(row(page2!, alias)).toContainText(text, { timeout: 60_000 });
});

After(async () => {
  await page2?.close().catch(() => {});
  await hub2?.stop();
  page2 = hub2 = undefined;
});

// A claude-ui Hub of its own in the host, run from the installed build with its own port and the host's default config dir.
const HUB_PORT = 4999;
const snapshot = (container: string) =>
  inHost(
    container,
    `cd ~/.config/claude-ui 2>/dev/null || echo no-config-dir; ls -A 2>/dev/null | sort; sha256sum daemon.json token 2>&1; pid=$(cat /tmp/e2e-hub.pid); if kill -0 $pid 2>/dev/null; then echo alive $pid; else echo dead $pid; fi; if bash -c 'exec 3<>/dev/tcp/127.0.0.1/${HUB_PORT}' 2>/dev/null; then echo port-open; else echo port-closed; fi; echo end`,
  );
let before = "";
When("a claude-ui Hub runs in the SSH host", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  inHost(
    name,
    `live=$(cat ~/.local/share/claude-ui/side/.live); nohup "$live/node/bin/node" "$live/node_modules/claude-code-ui/dist/cli.js" --port ${HUB_PORT} --no-open --no-update-check >/tmp/e2e-hub.log 2>&1 & echo $! > /tmp/e2e-hub.pid`,
  );
  await expect.poll(() => snapshot(name), { timeout: 60_000, message: inHost(name, "tail -20 /tmp/e2e-hub.log") }).toContain("port-open");
  // The Hub writes projects.json itself a moment after it listens: the baseline is taken once its own startup is done.
  await expect.poll(() => snapshot(name), { timeout: 60_000 }).toContain("projects.json");
  await sleep(5_000);
  before = snapshot(name);
  expect(before).toContain("daemon.json");
  expect(before).toContain("token");
});

Then("the claude-ui Hub in the SSH host is unchanged", async ({ sshHost }) => {
  expect(snapshot((await sshHost.get()).name)).toBe(before);
});
