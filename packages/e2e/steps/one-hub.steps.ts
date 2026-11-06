// One Hub per machine (GH-578, ADR 0009): see features/one-hub-per-machine.feature. POSIX with docker and the ssh tools only.
// Shared steps (throwaway host, choose host, open folder, Settings › Sides, Grace, unreachable) live in ssh-side*.steps.ts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { REMOTE_PROJECT } from "../support/ssh-host.ts";
import { openApp } from "../support/flow.ts";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { runDir, sshDir } from "../support/paths.ts";
import { openSettings } from "../support/ui.ts";
import { USER_HUB_PORT, endHubs, hubFile, hubPids, inHost, run, sleep, startHub } from "../support/ssh-hub.ts";
import { After, Then, When } from "./fixtures.ts";

const row = (page: Page, alias: string) => page.getByTestId(`settings-side-ssh:${alias}`);
let usedHost: string | undefined;

/** Ends the Hub of the host, starts another one in its place while the app is down, starts the app. */
async function replaceHub(daemon: Daemon, name: string, by: "user" | "attach", env = "") {
  usedHost = name;
  await daemon.stop();
  await endHubs(name);
  startHub(name, by, env);
  await expect.poll(() => hubFile(name)?.attach, { timeout: 60_000, message: inHost(name, `tail -20 /tmp/e2e-${by}-hub.log`) }).toBeTruthy();
  await daemon.restart();
}

// The installed package of a source checkout has no version (`dev`, which `claude-ui update` refuses): the host's install gets one, like a release has.
When("the claude-ui installed in the SSH host says it is version {string}", async ({ sshHost }, version: string) => {
  const name = (await sshHost.get()).name;
  inHost(name, `dir=$(ls -d ~/.local/share/claude-ui/side/*/ | head -n 1); dir=\${dir%/}; n=node; [ -x "$dir/node/bin/node" ] && n="$dir/node/bin/node"; "$n" -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p,null,2))' "$dir/node_modules/claude-code-ui/package.json" ${version}`);
  expect(inHost(name, `grep -c '"version": "${version}"' ~/.local/share/claude-ui/side/*/node_modules/claude-code-ui/package.json`).trim()).toBe("1");
});

When("I stop the app, replace the Hub of the SSH host by one the user started and start the app", async ({ daemon, sshHost }) => {
  await replaceHub(daemon, (await sshHost.get()).name, "user");
});

When("I stop the app, replace the Hub of the SSH host by one started by an attach with the schema {string} and start the app", async ({ daemon, sshHost }, schema: string) => {
  await replaceHub(daemon, (await sshHost.get()).name, "attach", `CLAUDE_UI_TEST_SCHEMA=${schema}`);
});

When("I end every Hub of the SSH host", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  usedHost = name;
  await endHubs(name);
});

When("I stop the app", async ({ daemon }) => {
  await daemon.stop();
});

When("I start the app", async ({ daemon }) => {
  await daemon.restart();
});

Then("one Hub runs in the SSH host", async ({ sshHost }) => {
  expect(hubPids((await sshHost.get()).name), "Hubs in the host").toHaveLength(1);
});

Then("the Hub of the SSH host was started by {string}", async ({ sshHost }, by: string) => {
  const f = hubFile((await sshHost.get()).name);
  expect(f, "daemon.json of the host").toBeTruthy();
  if (by === "an attach") expect(f!.startedBy).toBe("attach");
  else expect(f!.startedBy).toBeUndefined();
});

Then("the Hub of the SSH host runs the schema {string}", async ({ sshHost }, schema: string) => {
  expect(hubFile((await sshHost.get()).name)?.schema?.join(",")).toBe(schema);
});

// The pid of the Hub the user started is the one in daemon.json (after it retired an attach-started Hub).
Then("the Hub of the SSH host is the one the user started", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  const user = inHost(name, "cat /tmp/e2e-user-hub.pid").trim();
  expect(hubPids(name)).toEqual([user]);
  expect(String(hubFile(name)?.pid)).toBe(user);
});

// The host's own view: the Hub there lists the project the attached Hub opened (a client command run in the host, like a user would).
Then("the Hub of the SSH host lists the remote project itself", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  const out = inHost(name, 'dir=$(ls -d ~/.local/share/claude-ui/side/*/ | head -n 1); dir=${dir%/}; n=node; [ -x "$dir/node/bin/node" ] && n="$dir/node/bin/node"; "$n" "$dir/node_modules/claude-code-ui/dist/cli.js" projects');
  expect(out, "claude-ui projects in the host").toContain(REMOTE_PROJECT);
});

Then("the Settings row of the SSH host {string} shows the Update button", async ({ page }, alias: string) => {
  await expect(page.getByTestId(`settings-side-update-remote-ssh:${alias}`)).toBeVisible({ timeout: 60_000 });
});

When("I click Update on the Settings row of the SSH host {string}", async ({ page }, alias: string) => {
  await page.getByTestId(`settings-side-update-remote-ssh:${alias}`).click();
});

When("the viewport becomes {int}x{int}", async ({ page }, width: number, height: number) => {
  await page.setViewportSize({ width, height });
});

Then("the Settings row of the SSH host {string} fits the viewport", async ({ page }, alias: string) => {
  const m = await row(page, alias).evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth, right: e.getBoundingClientRect().right, inner: window.innerWidth }));
  expect(m.scroll, "row scrollWidth").toBeLessThanOrEqual(m.client);
  expect(m.right, "row right edge").toBeLessThanOrEqual(m.inner);
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

Then("I capture the second Claude UI as {string}", async ({ $testInfo }, name: string) => {
  const file = join(runDir(), `${name}.png`);
  await page2!.screenshot({ path: file });
  await $testInfo.attach(name, { path: file, contentType: "image/png" });
});

// The states a Settings row shows are recorded in the page from here on, so a short Reconnecting is not missed by polling.
When("I watch the Settings row of the SSH host {string}", async ({ page }, alias: string) => {
  await page.evaluate((a) => {
    const w = window as unknown as { __rowStates: string[] };
    w.__rowStates = [];
    const read = () => {
      const t = document.querySelector(`[data-testid="settings-side-ssh:${a}"]`)?.textContent ?? "";
      for (const s of ["Reconnecting", "Running"]) if (t.includes(s) && w.__rowStates.at(-1) !== s) w.__rowStates.push(s);
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true });
    read();
  }, alias);
});

// The user's own `claude-ui` in the host (what a person does in a terminal there): port 4999, output to a file.
When("the user starts claude-ui in the SSH host", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  usedHost = name;
  startHub(name, "user");
});

Then("the Settings row of the SSH host {string} went from Reconnecting to Running by itself", async ({ page }, _alias: string) => {
  const seen = () => page.evaluate(() => (window as unknown as { __rowStates: string[] }).__rowStates.join(" > "));
  await expect.poll(seen, { timeout: 120_000, message: "row states seen" }).toMatch(/Reconnecting > Running$/);
});

// The kill of the Hub's ssh process may come before the daemon's bridge ssh exists (the row says Running a moment early) or hit an ssh that is no longer the Side's pipe:
// kill again until the row shows Reconnecting, so the reattach that follows is really observed.
When("I kill the Hub's ssh process of the SSH host {string} until the row shows Reconnecting", async ({ page }, alias: string) => {
  const reconnecting = () => page.evaluate(() => (window as unknown as { __rowStates: string[] }).__rowStates.includes("Reconnecting"));
  const killAll = () => {
    for (const p of run("pgrep", ["-f", `ssh .*-F ${join(sshDir(runDir()), "config")} -- ${alias}`]).split(/\s+/).filter(Boolean)) process.kill(Number(p), "SIGKILL");
  };
  await expect
    .poll(async () => (killAll(), await sleep(1_000), reconnecting()), { timeout: 60_000, intervals: [0], message: "the row never showed Reconnecting after the ssh kill" })
    .toBe(true);
});

// No turn runs in this scenario (the host has no Claude login): the user's start prints no waiting line and does not fail.
Then("the user's claude-ui in the SSH host printed no waiting line", async ({ sshHost }) => {
  const log = inHost((await sshHost.get()).name, "cat /tmp/e2e-user-hub.log");
  expect(log).not.toContain("waiting for its");
  expect(log).not.toMatch(/would not retire|keeps starting/);
});

// Scenario 2: the Hub of an attach ends by its Grace period once the app is gone.
Then("no Hub runs in the SSH host within {int} seconds", async ({ sshHost }, seconds: number) => {
  const name = (await sshHost.get()).name;
  const end = Date.now() + seconds * 1000;
  while (hubPids(name).length && Date.now() < end) await sleep(2_000);
  expect(hubPids(name), "Hubs in the host").toEqual([]);
});

// GH-619: a Hub another install folder started (a different build) is the only claude-ui running in the host; this build's folder is not there.
const ROOT = "~/.local/share/claude-ui";
let movedHost: string | undefined;
When("I stop the app, move this build out of the SSH host and start the Hub the user started from there and start the app", async ({ daemon, sshHost }) => {
  const name = (await sshHost.get()).name;
  usedHost = movedHost = name;
  await daemon.stop();
  await endHubs(name);
  // npm fails: an install attempt would show an error (the bundle install does not need it, the folder assertion catches that one).
  inHost(name, `printf '#!/bin/sh\\necho npm shim: install not allowed >&2\\nexit 1\\n' > /usr/local/bin/npm && chmod +x /usr/local/bin/npm; mkdir -p ${ROOT}/other && for d in ${ROOT}/side/*/; do mv "\${d%/}" ${ROOT}/other/; done`);
  expect(inHost(name, `ls ${ROOT}/side | wc -l`).trim(), "this build's folder is gone").toBe("0");
  inHost(name, `dir=$(ls -d ${ROOT}/other/*/ | head -n 1); dir=\${dir%/}; cli="$dir/node_modules/claude-code-ui/dist/cli.js"; n=node; [ -x "$dir/node/bin/node" ] && n="$dir/node/bin/node"; nohup "$n" "$cli" --no-open --no-update-check --port ${USER_HUB_PORT} </dev/null >/tmp/e2e-user-hub.log 2>&1 & echo $! > /tmp/e2e-user-hub.pid`);
  await expect.poll(() => hubFile(name)?.attach, { timeout: 60_000, message: inHost(name, "tail -20 /tmp/e2e-user-hub.log") }).toBeTruthy();
  await daemon.restart();
});

Then("the claude-ui folder of this build does not exist in the SSH host", async ({ sshHost }) => {
  const name = (await sshHost.get()).name;
  expect(inHost(name, `ls ${ROOT}/side | wc -l`).trim(), `this build's folder in ${ROOT}/side`).toBe("0");
  expect(inHost(name, "which npm; cat /usr/local/bin/npm | head -c 20").trim(), "npm shim stays in place").toContain("#!/bin/sh");
});

// Records every Install, Update and Retry button the side panel (or its check) ever shows, from the first page load on.
When("I watch for the Install and Update buttons", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __buttons: string[] };
    w.__buttons = [];
    const read = () => {
      for (const id of ["side-install", "side-update-remote"]) if (document.querySelector(`[data-testid="${id}"]`) && !w.__buttons.includes(id)) w.__buttons.push(id);
    };
    new MutationObserver(read).observe(document, { subtree: true, childList: true, attributes: true });
  });
});

Then("the side panel never showed an Install or Update button", async ({ page }) => {
  expect(await page.evaluate(() => (window as unknown as { __buttons: string[] }).__buttons), "buttons seen").toEqual([]);
});

After(async () => {
  if (movedHost) {
    // Put this build back: the next scenarios start from an installed host.
    await endHubs(movedHost);
    inHost(movedHost, `rm -f /usr/local/bin/npm; for d in ${ROOT}/other/*/; do mv "\${d%/}" ${ROOT}/side/; done`);
    movedHost = undefined;
  }
  await page2?.close().catch(() => {});
  await hub2?.stop();
  page2 = hub2 = undefined;
  // A Hub the user (or a test) started stays out of the next scenario: the next one starts from an installed host without a Hub unless it says so.
  if (usedHost) await endHubs(usedHost);
  usedHost = undefined;
});

Then("the folder browser of Open project shows", async ({ page }) => {
  await expect(page.getByTestId("folder-input")).toBeVisible({ timeout: 240_000 });
});
