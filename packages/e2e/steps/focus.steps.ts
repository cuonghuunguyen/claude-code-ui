
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject, prepareHaikuSession } from "../support/flow.ts";
import { projectsRoot, runDir, slug, testSlugs } from "../support/paths.ts";
import { TURN_MS } from "../support/ui.ts";
import { After, Given, Then, When } from "./fixtures.ts";

async function clickFocus(page: Page) {
  // On a phone the tab strip sits behind the switcher.
  if (await page.getByTestId("focus-tab").isVisible()) await page.getByTestId("focus-tab").click();
  else {
    await page.getByTestId("tab-switcher").click();
    await page.getByRole("option", { name: /^Focus/ }).click();
  }
}

When("I open Focus", async ({ page }) => {
  await clickFocus(page);
  await expect(page.getByTestId("focus-page")).toBeVisible();
});

When("I select the {word} request in Focus", async ({ page }, kind: string) => {
  // The worker's daemon is shared by scenarios: an earlier scenario's session may still wait, so pick by kind.
  const row = page.locator(`[data-testid="focus-row"][data-kind="${kind}"]`).first();
  await expect(row).toBeVisible({ timeout: TURN_MS });
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");
});

Then("the Focus detail has a Question card", async ({ page }) => {
  await expect(page.getByTestId("focus-detail").getByTestId("question-panel")).toHaveCount(1);
});

// Next for you without a real suggestion (the real CLI sends one only sometimes, seconds after a turn): the scenario's own daemon runs its Claude
// sessions on the fake CLI (support/fake-claude-cli.mjs, CLAUDE_UI_E2E_CLAUDE_CLI). Its turn waits for the gate file, whose text it sends as the
// prompt suggestion after the turn, the way the real CLI does. No model call.
const FAKE_CLI = fileURLToPath(new URL("../support/fake-claude-cli.mjs", import.meta.url));
let fake: { daemon: Daemon; gate: string; project: string } | undefined;

After(async () => {
  await fake?.daemon.stop();
  if (fake) rmSync(fake.gate, { recursive: true, force: true });
  fake = undefined;
});

Given("the app is open on a daemon whose Claude sessions run the fake CLI", async ({ page, $testInfo }) => {
  const run = runDir();
  // Not the `project` fixture: it starts the worker daemon. The same project settings: a write asks first.
  const { feature, scenario } = testSlugs($testInfo);
  const project = `${slug(`${feature}-${scenario}`, 56)}-r${$testInfo.retry}`;
  const path = join(projectsRoot(run), project);
  mkdirSync(join(path, ".claude"), { recursive: true });
  writeFileSync(join(path, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "default" } }, null, 2));
  const gate = join(run, `fake-claude-gate-w${$testInfo.workerIndex}`);
  mkdirSync(gate, { recursive: true });
  const daemon = await startDaemon(run, 3000 + $testInfo.workerIndex, { port: await freePort(ownerPorts(), ""), env: { CLAUDE_UI_E2E_CLAUDE_CLI: FAKE_CLI, FAKE_CLAUDE_GATE: gate } });
  fake = { daemon, gate, project };
  await openApp(page, daemon);
  await openProject(page, path);
});

Given("I start a new Haiku session on the fake CLI", async ({ page }) => {
  await prepareHaikuSession(page, fake!.project);
});

When("the fake CLI ends the turn with the suggestion {string}", async ({}, text: string) => {
  writeFileSync(join(fake!.gate, "next"), text);
});
