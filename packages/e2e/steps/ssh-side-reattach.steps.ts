// SSH Side after a Hub restart (GH-549, ADR 0009): see features/ssh-side-reattach.feature. POSIX with docker and the ssh tools only.
// Shared steps (throwaway host, choose host, Settings › Sides, Grace, unreachable, kill ssh) live in ssh-side.steps.ts / ssh-side-survive.steps.ts;
// the Hub the user starts in the host and the second Claude UI live in one-hub.steps.ts.
import { expect, type Page } from "@playwright/test";
import { endHubs, hubPids, inHost, sleep } from "../support/ssh-hub.ts";
import { Then, When } from "./fixtures.ts";

const row = (page: Page, alias: string) => page.getByTestId(`settings-side-ssh:${alias}`);

let remembered: string[] = [];
When("I remember the Hub of the SSH host", async ({ sshHost }) => {
  remembered = hubPids((await sshHost.get()).name);
  expect(remembered.length, "Hubs in the host").toBe(1);
});

Then("the Hub of the SSH host is the remembered one", async ({ sshHost }) => {
  expect(hubPids((await sshHost.get()).name)).toEqual(remembered);
});

Then("no Hub runs in the SSH host", async ({ sshHost }) => {
  expect(hubPids((await sshHost.get()).name)).toEqual([]);
});

Then("the Settings row of the SSH host {string} does not say {string}", async ({ page }, alias: string, text: string) => {
  await row(page, alias).scrollIntoViewIfNeeded();
  await expect(row(page, alias)).not.toContainText(text);
});

// The app goes down first (its exit must not end the Hub of the host), then the Hub ends, then the app starts: its boot attach finds none.
When("I stop the app, end the Hub of the SSH host and start the app", async ({ daemon, sshHost }) => {
  const name = (await sshHost.get()).name;
  await daemon.stop();
  await endHubs(name);
  expect(hubPids(name), "Hubs after the kill").toEqual([]);
  await daemon.restart();
});

// A Hub the user started in the host is attached to as it is: its own config dir is not touched (ADR 0009 "never reconfigured").
const snapshot = (container: string) =>
  inHost(container, `cd ~/.config/claude-ui 2>/dev/null || echo no-config-dir; ls -A 2>/dev/null | sort; sha256sum daemon.json token settings.json 2>&1; pid=$(cat /tmp/e2e-user-hub.pid); if kill -0 $pid 2>/dev/null; then echo alive $pid; else echo dead $pid; fi; echo end`);
let before = "";
When("I note the config of the Hub the user started in the SSH host", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  // The Hub writes projects.json itself a moment after it listens: the baseline is taken once its own startup is done.
  await expect.poll(() => snapshot(name), { timeout: 60_000 }).toContain("projects.json");
  await sleep(5_000);
  before = snapshot(name);
  expect(before).toContain("daemon.json");
  expect(before).toContain("token");
  expect(before).toContain("alive");
});

Then("the Hub the user started in the SSH host is unchanged", async ({ sshHost }) => {
  expect(snapshot((await sshHost.get()).name)).toBe(before);
});
