import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject } from "../support/flow.ts";
import { runDir } from "../support/paths.ts";
import { RECONNECT_MS, waitConnected } from "../support/ui.ts";
import { writePublishTranscript } from "../support/fake-transcript.ts";
import { Given, Then, When, After } from "./fixtures.ts";
import { randomUUID } from "node:crypto";

const PAGE_HTML = `<!doctype html><html><body><h1>Sales dashboard</h1><script>try { top.location = "https://example.com"; } catch (e) {}</script></body></html>`;
/** The scenario's own daemon: its CLAUDE_CONFIG_DIR is inside the run folder, so the synthetic transcript never lands in the real ~/.claude, and no model is involved. */
let own: Daemon | undefined;
/** The transcript of the scenario's session; its project folder is removed afterwards. */
let transcript: string | undefined;
let urlBefore = "";

const tab = (page: Page, name: string): Locator => page.locator('[data-testid="tab"][data-tab-id^="artifact:"]').filter({ hasText: name });
const strip = (page: Page, name: string): Locator => tab(page, name).locator('[role="tab"]');
const body = (page: Page): Locator => page.locator("[data-pane-tab-body^='artifact:']");
const card = (page: Page): Locator => page.getByTestId("tool-card").filter({ hasText: "Sales dashboard" }).first();
const frame = (page: Page) => page.frameLocator("[data-pane-tab-body^='artifact:'] iframe");

Given("a session that published the page {string} titled {string}", async ({ page, project, $testInfo }, name: string, title: string) => {
  const file = join(project.path, name);
  writeFileSync(file, PAGE_HTML);
  const run = runDir();
  const configDir = join(run, `claude-config-w${$testInfo.workerIndex}`);
  transcript = writePublishTranscript({ sessionId: randomUUID(), cwd: project.path, file, title, url: "https://claude.ai/artifact/AbC123", configDir, run });
  own = await startDaemon(run, 1000 + $testInfo.workerIndex, { port: await freePort(ownerPorts(), ""), env: { CLAUDE_CONFIG_DIR: configDir } });
  await openApp(page, own);
  await openProject(page, project.path);
  const row = page.getByTestId("session-item").filter({ hasText: "Publish the dashboard" }).first();
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await row.click({ timeout: 60_000 });
  await expect(card(page)).toBeVisible({ timeout: 30_000 });
});

After(async () => {
  await own?.stop();
  own = undefined;
  if (transcript) rmSync(dirname(transcript), { recursive: true, force: true });
  transcript = undefined;
});

When("I restart the artifact daemon", async ({ page }) => {
  const lost = expect(page.getByTestId("connection-status").first()).not.toHaveText(/^\s*connected\s*$/, { timeout: RECONNECT_MS });
  const [restarted, seen] = await Promise.allSettled([own!.restart(), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
  await waitConnected(page);
});

When("I note the page URL", async ({ page }) => {
  urlBefore = page.url();
});

When("I expand the Artifact card", async ({ page }) => {
  if ((await card(page).getByTestId("artifact-publish").count()) === 0) await card(page).locator("button").first().click();
  await expect(card(page).getByTestId("artifact-publish")).toBeVisible();
});

When("I click Show preview on the Artifact card", async ({ page }) => {
  await card(page).getByRole("button", { name: "Show preview", exact: true }).click();
});

When("I click Hide preview on the Artifact card", async ({ page }) => {
  await card(page).getByRole("button", { name: "Hide preview", exact: true }).click();
});

When("I click Open in tab on the Artifact card", async ({ page }) => {
  await card(page).getByRole("button", { name: "Open in tab", exact: true }).click();
});

When("I close the artifact tab {string}", async ({ page }, name: string) => {
  await tab(page, name).getByTestId("tab-close").click({ force: true });
  await expect(tab(page, name)).toHaveCount(0);
});

When("I click the session tab {string}", async ({ page }, name: string) => {
  await page.getByTestId("tab-strip").getByRole("tab", { name, exact: true }).click();
});

When("I click the artifact tab {string}", async ({ page }, name: string) => {
  await strip(page, name).click();
});

When("I click Reload in the artifact tab", async ({ page }) => {
  await body(page).getByRole("button", { name: "Reload", exact: true }).click();
});

When("I choose {string} in the menu of the artifact tab {string}", async ({ page }, label: string, name: string) => {
  await tab(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

When("I pick the artifact row {string} in the tab switcher", async ({ page }, name: string) => {
  await page.getByRole("option").filter({ hasText: name }).click();
});

Then("the artifact tab {string} opens right of its session tab, active and focused", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveCount(1);
  await expect(strip(page, name)).toHaveAttribute("aria-selected", "true");
  await expect(strip(page, name)).toBeFocused();
  const ids = await page.locator('[data-testid="tab-strip"] [data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id") ?? ""));
  const at = ids.findIndex((i) => i.startsWith("artifact:"));
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe(ids[at]!.split(":")[1]);
});

Then("the artifact tab {string} is active and focused", async ({ page }, name: string) => {
  await expect(strip(page, name)).toHaveAttribute("aria-selected", "true");
  await expect(strip(page, name)).toBeFocused();
});

Then("there is one artifact tab {string}", async ({ page }, name: string) => {
  await expect(tab(page, name)).toHaveCount(1);
});

Then("the artifact tab shows the page with the heading {string}", async ({ page }, text: string) => {
  await expect(frame(page).getByRole("heading", { name: text })).toBeVisible({ timeout: 30_000 });
});

Then("the page of the artifact tab fills the tab", async ({ page }) => {
  const [f, b] = [await body(page).locator("iframe").boundingBox(), await body(page).boundingBox()];
  expect(f!.height).toBeGreaterThanOrEqual(b!.height * 0.8);
});

Then("the artifact tab has Reload and the offline line", async ({ page }) => {
  await expect(body(page).getByRole("button", { name: "Reload", exact: true })).toBeVisible();
  await expect(body(page)).toContainText("Local file, shown offline");
});

Then("the page URL is unchanged", async ({ page }) => {
  // The page tries to navigate the top level; the sandbox refuses it.
  await page.waitForTimeout(500);
  expect(page.url().split("#")[0]).toBe(urlBefore.split("#")[0]);
  expect(page.url()).not.toContain("example.com");
});

Then("the Artifact card still shows the page", async ({ page }) => {
  await expect(card(page).locator("iframe")).toBeVisible();
});

Then("the artifact tab shows the error {string}", async ({ page }, text: string) => {
  await expect(body(page).getByRole("alert")).toHaveText(text);
});

Then("the artifact tab {string} is shown in a split", async ({ page }, name: string) => {
  expect(name).toBeTruthy();
  await expect(page.locator('[data-testid="split"][data-pane-tab-body^="artifact:"]')).toBeVisible();
});

Then("the artifact split fills its half", async ({ page }) => {
  const split = page.locator('[data-testid="split"][data-pane-tab-body^="artifact:"]');
  const [f, s] = [await split.locator("iframe").boundingBox(), await split.boundingBox()];
  expect(f!.height).toBeGreaterThanOrEqual(s!.height * 0.7);
  expect(f!.width).toBeGreaterThanOrEqual(s!.width * 0.9);
});

Then("the tab switcher lists the artifact row {string}", async ({ page }, name: string) => {
  await expect(page.getByRole("option").filter({ hasText: name })).toHaveCount(1);
});
