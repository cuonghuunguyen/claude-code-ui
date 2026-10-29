import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject } from "../support/flow.ts";
import { runDir } from "../support/paths.ts";
import { RECONNECT_MS, waitConnected } from "../support/ui.ts";
import { writeTurnsTranscript } from "../support/fake-transcript.ts";
import { Given, Then, When, After } from "./fixtures.ts";

const page_html = (h: string) => `<!doctype html><html><body><h1>${h}</h1></body></html>`;
/** The scenario's own daemon: its CLAUDE_CONFIG_DIR is inside the run folder, so the synthetic transcript never lands in the real ~/.claude and nothing publishes to claude.ai. */
let own: Daemon | undefined;
let transcript: string | undefined;

const pane = (page: Page): Locator => page.getByTestId("artifacts-pane");
const rows = (page: Page): Locator => pane(page).getByRole("option");
const dockTab = (page: Page): Locator => page.locator('[data-testid="side-panel"] [data-testid="pane-artifacts"], [data-testid="bottom-panel"] [data-testid="pane-artifacts"]');
const artifactsTabs = (page: Page): Locator => page.locator('[data-testid="tab"][data-tab-id^="artifacts:"]');

async function start(page: Page, project: { path: string }, workerIndex: number, turns: number, publishes: Parameters<typeof writeTurnsTranscript>[0]["publishes"]) {
  const run = runDir();
  const configDir = join(run, `claude-config-w${workerIndex}`);
  transcript = writeTurnsTranscript({ sessionId: randomUUID(), cwd: project.path, configDir, run, turns, publishes });
  own = await startDaemon(run, 1000 + workerIndex, { port: await freePort(ownerPorts(), ""), env: { CLAUDE_CONFIG_DIR: configDir } });
  await openApp(page, own);
  await openProject(page, project.path);
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("session-item").filter({ hasText: "Turn 1" }).first().click({ timeout: 60_000 });
  await expect(page.getByTestId("user-message").last()).toBeVisible({ timeout: 30_000 });
}

// 12 turns are more than one page (10 turns): the publishes of turns 1 and 2 are in the part of the session that is not loaded.
Given("a session of 12 turns that published report.html, chart.html, notes.md and chart.html again", async ({ page, project, $testInfo }) => {
  writeFileSync(join(project.path, "report.html"), page_html("Report page"));
  writeFileSync(join(project.path, "chart.html"), page_html("Chart page"));
  writeFileSync(join(project.path, "notes.md"), "# Notes\n");
  const url = (id: string) => `https://claude.ai/artifact/${id}`;
  await start(page, project, $testInfo.workerIndex, 12, {
    1: { file: join(project.path, "report.html"), url: url("RepOrt1") },
    2: { file: join(project.path, "chart.html"), url: url("ChArt1") },
    11: { file: join(project.path, "notes.md"), url: url("NoTes1") },
    12: { file: join(project.path, "chart.html"), url: url("ChArt1") },
  });
});

Given("a session of 3 turns without a publish", async ({ page, project, $testInfo }) => {
  await start(page, project, $testInfo.workerIndex, 3, {});
});

After(async () => {
  await own?.stop();
  own = undefined;
  if (transcript) rmSync(dirname(transcript), { recursive: true, force: true });
  transcript = undefined;
});

When("I restart the Artifacts daemon", async ({ page }) => {
  const lost = expect(page.getByTestId("connection-status").first()).not.toHaveText(/^\s*connected\s*$/, { timeout: RECONNECT_MS });
  const [restarted, seen] = await Promise.allSettled([own!.restart(), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
  await waitConnected(page);
});

Then("the side panel lists the Artifacts tab", async ({ page }) => {
  await expect(page.getByTestId("side-panel").getByTestId("pane-artifacts")).toBeVisible({ timeout: 30_000 });
});

Then("the side panel has no Artifacts tab", async ({ page }) => {
  await expect(page.getByTestId("side-panel")).toBeVisible();
  await expect(page.getByTestId("side-panel").getByTestId("pane-artifacts")).toHaveCount(0);
});

Then("the bottom panel lists the Artifacts tab", async ({ page }) => {
  await expect(page.getByTestId("bottom-panel").getByTestId("pane-artifacts")).toBeVisible();
});

When("I open the Artifacts pane", async ({ page }) => {
  await dockTab(page).first().click();
  await expect(pane(page)).toBeVisible();
});

/** A narrow pane shows the list or the preview, not both. */
async function showList(page: Page): Promise<void> {
  const back = pane(page).getByRole("button", { name: "All artifacts" });
  if (await back.isVisible()) await back.click();
}

Then("the Artifacts pane lists {int} rows in the order {string}", async ({ page }, n: number, order: string) => {
  await showList(page);
  await expect(rows(page)).toHaveCount(n, { timeout: 30_000 });
  const titles = await pane(page).getByTestId("artifact-row-title").allTextContents();
  expect(titles).toEqual(order.split(", "));
});

Then("each Artifacts row shows a relative time", async ({ page }) => {
  for (const t of await rows(page).allTextContents()) expect(t).toMatch(/(now|\d+[mhd])$/);
});

When("I select the artifact {string} in the Artifacts pane", async ({ page }, name: string) => {
  // A narrow pane (the side panel at 1440 px) shows the list or the preview, not both: go back to the list first.
  const back = pane(page).getByRole("button", { name: "All artifacts" });
  if (await back.isVisible()) await back.click();
  await rows(page).filter({ hasText: name }).click();
  await expect(pane(page).getByTestId("artifacts-preview")).toBeVisible();
});

Then("the Artifacts pane previews the page with the heading {string}", async ({ page }, text: string) => {
  // Narrow pane showing the list: open the selected row.
  const selected = rows(page).and(page.locator('[aria-selected="true"]'));
  if (await selected.isVisible()) await selected.click();
  await expect(pane(page).frameLocator("iframe").getByRole("heading", { name: text })).toBeVisible({ timeout: 30_000 });
});

Then("the Artifacts pane says No local preview with a claude.ai link", async ({ page }) => {
  await expect(pane(page)).toContainText("No local preview");
  await expect(pane(page).locator('a[href^="https://claude.ai/artifact/"]')).toBeVisible();
});

When("I click Open in tab in the Artifacts pane", async ({ page }) => {
  await pane(page).getByRole("button", { name: "Open in tab", exact: true }).click();
});

Then("the artifact tab {string} is closed", async ({ page }, name: string) => {
  await expect(page.locator('[data-testid="tab"][data-tab-id^="artifact:"]').filter({ hasText: name })).toHaveCount(0);
});

Then("the Artifacts pane has {string} selected", async ({ page }, name: string) => {
  await showList(page);
  await expect(rows(page).filter({ hasText: name })).toHaveAttribute("aria-selected", "true");
});

When("I move the Artifacts pane to the bottom panel from its tab menu", async ({ page }) => {
  await dockTab(page).first().click({ button: "right" });
  await page.getByTestId("pane-move").click();
});

When("I move the Artifacts pane to the main area from its tab menu", async ({ page }) => {
  await dockTab(page).first().click({ button: "right" });
  await page.getByTestId("pane-move-main").click();
});

Then("there is one Artifacts tab in the main area", async ({ page }) => {
  await expect(artifactsTabs(page)).toHaveCount(1);
  await expect(artifactsTabs(page)).toContainText("Artifacts ·");
});

Then("the pane switcher lists Artifacts", async ({ page }) => {
  await expect(page.getByTestId("pane-artifacts").first()).toBeVisible();
  await expect(page.getByTestId("pane-session").first()).toBeVisible();
});

When("I pick Artifacts in the pane switcher", async ({ page }) => {
  await page.getByTestId("pane-artifacts").first().click();
});

When("I go back to all artifacts", async ({ page }) => {
  await pane(page).getByRole("button", { name: "All artifacts", exact: true }).click();
});

Then("the Artifacts pane shows the preview and the All artifacts button", async ({ page }) => {
  await expect(pane(page).getByRole("button", { name: "All artifacts", exact: true })).toBeVisible();
  await expect(pane(page).locator("iframe")).toBeVisible({ timeout: 30_000 });
});
