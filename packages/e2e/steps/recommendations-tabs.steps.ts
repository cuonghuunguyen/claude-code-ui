import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject } from "../support/flow.ts";
import { projectsRoot, runDir, slug, testSlugs } from "../support/paths.ts";
import { writeTurnsTranscript } from "../support/fake-transcript.ts";
import { After, Given, Then, When } from "./fixtures.ts";

// Saved sessions (synthetic transcripts, no Claude) give as many tabs as a scenario needs. The scenario's own daemon keeps CLAUDE_CONFIG_DIR inside the run folder.
let own: Daemon | undefined;
let transcripts: string[] = [];
let titles: string[] = [];
let opened = 0;

After(async () => {
  await own?.stop();
  own = undefined;
  for (const t of transcripts) rmSync(dirname(t), { recursive: true, force: true });
  transcripts = [];
  titles = [];
  opened = 0;
});

Given("the app is open with {int} saved sessions in each of {int} projects", async ({ page, $testInfo }, per: number, projects: number) => {
  const run = runDir();
  // Not the `project` fixture: it starts the worker daemon, which would hold E2E_PORT.
  const { feature, scenario } = testSlugs($testInfo);
  const base = join(projectsRoot(run), slug(`${feature}-${scenario}`, 56));
  const configDir = join(run, `claude-config-w${$testInfo.workerIndex}`);
  const dirs: string[] = [];
  titles = [];
  opened = 0;
  for (let p = 1; p <= projects; p++) {
    const dir = `${base}-p${p}`;
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    for (let i = 1; i <= per; i++) {
      const first = `Saved P${p} S${String(i).padStart(2, "0")}`;
      titles.push(first);
      transcripts.push(writeTurnsTranscript({ sessionId: randomUUID(), cwd: dir, configDir, run, turns: 1, first, publishes: {} }));
    }
  }
  own = await startDaemon(run, 1000 + $testInfo.workerIndex, { port: await freePort(ownerPorts(), ""), env: { CLAUDE_CONFIG_DIR: configDir } });
  await openApp(page, own);
  for (const d of dirs) await openProject(page, d);
});

async function openSaved(page: Page, title: string) {
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  // The sidebar pages its sessions (5 per project): search for the title.
  const search = page.getByTestId("session-search");
  await search.fill(title);
  await page.getByTestId("session-item").filter({ hasText: title }).first().click({ timeout: 60_000 });
  await search.fill("");
  await expect(page.getByTestId("user-message").last()).toContainText(title, { timeout: 30_000 });
}

When("I open {int} more saved sessions", async ({ page }, n: number) => {
  for (let i = 0; i < n; i++) await openSaved(page, titles[opened++]!);
});

When("I open the next saved session", async ({ page }) => {
  await openSaved(page, titles[opened++]!);
});

Then("no toast shows", async ({ page }) => {
  await expect(page.getByTestId("toast-region")).toBeAttached();
  await expect(page.getByTestId("toast-region").locator('[data-testid="toast"]')).toHaveCount(0);
});

Then("{int} toasts show", async ({ page }, n: number) => {
  await expect(page.getByTestId("toast-region").locator('[data-testid="toast"]')).toHaveCount(n);
});

Then("the toast {string} shows with the button {string}", async ({ page }, text: string, button: string) => {
  const t = page.getByTestId("toast").filter({ hasText: text });
  await expect(t).toHaveCount(1);
  await expect(t).toHaveAttribute("data-state", "open"); // slid in, so the capture shows it fully
  await expect(t.getByRole("button")).toHaveCount(2); // the action and Dismiss
  await expect(t.getByRole("button", { name: button, exact: true })).toBeVisible();
});

When("I hover the toast {string}", async ({ page }, text: string) => {
  await page.getByTestId("toast").filter({ hasText: text }).hover();
});

When("I click {string} in the toast {string}", async ({ page }, button: string, text: string) => {
  await page.getByTestId("toast").filter({ hasText: text }).getByRole("button", { name: button, exact: true }).click();
});

When("I dismiss the toast {string}", async ({ page }, text: string) => {
  await page.getByTestId("toast").filter({ hasText: text }).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(page.getByTestId("toast").filter({ hasText: text })).toHaveCount(0);
});

// The page "Clean up tabs…" of the palette lists the cleanup rules, not the whole command list.
Then("the palette shows the Clean up tabs page", async ({ page }) => {
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("option", { name: /^Close idle tabs/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /^Close finished tabs/ })).toBeVisible();
  await expect(palette.getByRole("option", { name: /^New session/ })).toHaveCount(0);
});

Then("compact tabs are on and tabs are grouped by project", async ({ page }) => {
  await expect(page.locator("[data-group-chip]")).toHaveCount(3);
});
