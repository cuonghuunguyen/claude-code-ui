import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { evidenceDir, runDir } from "../support/paths.ts";
import { callsTotal, fixtureFiles, inlineResults, parentCalls, priceOf, readCosts, subagentCalls, tokenSum, writeCost, type Call, type InlineResult } from "../support/inline-task.ts";
import { TURN_MS, idleSend, openSettings } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

// GH-734: the inline_task tool and its run card (docs/spec.md "Inline tasks"). Structure only, never the reply wording.

const card = (page: Page): Locator => page.getByTestId("run-card").first();
const header = (page: Page): Locator => card(page).locator("button[aria-expanded]").first();
const STATUS: Record<string, string> = { running: "running", finished: "done", stopped: "stopped", failed: "error", denied: "denied" };

async function opened(page: Page): Promise<Locator> {
  await expect(card(page)).toBeVisible({ timeout: TURN_MS });
  if ((await header(page).getAttribute("aria-expanded")) === "false") await header(page).click();
  await expect(header(page)).toHaveAttribute("aria-expanded", "true");
  return card(page);
}

Given("the scratch project has the inline task fixtures", async ({ project }) => {
  for (const [name, text] of Object.entries(fixtureFiles())) {
    const file = join(project.path, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
});

Given("the scratch project has the Playwright MCP server", async ({ project }) => {
  writeFileSync(join(project.path, ".mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"] } } }, null, 2));
  const settings = join(project.path, ".claude", "settings.json");
  const current = JSON.parse(readFileSync(settings, "utf8"));
  writeFileSync(settings, JSON.stringify({ ...current, enableAllProjectMcpServers: true }, null, 2));
});

When("I set inline tasks to {word} with at most {int} turns in Settings", async ({ page }, state: string, turns: number) => {
  await openSettings(page);
  await page.getByTestId("settings-group-inlineTask").click();
  const toggle = page.getByTestId("settings-inlineTask-enabled");
  await expect(toggle).toBeVisible();
  const on = state === "on";
  if ((await toggle.getAttribute("aria-checked")) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(on));
  const max = page.getByTestId("settings-inlineTask-maxTurns");
  await max.fill(String(turns));
  await max.press("Enter");
  await page.waitForTimeout(600); // the save round trip to the daemon
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

When("I deny permission requests until the turn has finished", async ({ page }) => {
  await untilTurnEnds(page, "Deny");
});

When("I allow permission requests until the turn has finished", async ({ page }) => {
  await untilTurnEnds(page, "Allow once");
});

async function untilTurnEnds(page: Page, answer: string) {
  // The send button leaves idle once the turn starts; a very fast turn may already be back at idle.
  await expect(page.locator('[data-testid="send"]:not([data-state="idle"])').or(page.getByTestId("permission-panel"))).toBeVisible({ timeout: 30_000 }).catch(() => {});
  const deadline = Date.now() + 4 * TURN_MS;
  let calm = 0;
  while (Date.now() < deadline) {
    const panel = page.getByTestId("permission-panel");
    if (await panel.isVisible()) {
      calm = 0;
      await panel.getByRole("button", { name: answer }).click({ timeout: 10_000 }).catch(() => {});
    } else if (await idleSend(page).isVisible()) {
      if (++calm >= 3) return;
    } else calm = 0;
    await page.waitForTimeout(700);
  }
  throw new Error("the turn did not finish");
}

Then("the permission request shows {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("permission-panel")).toContainText(text, { timeout: TURN_MS });
});

Then("the inline task card is {word}", async ({ page }, outcome: string) => {
  const status = STATUS[outcome];
  if (!status) throw new Error(`unknown outcome "${outcome}"; use one of ${Object.keys(STATUS).join(", ")}`);
  await expect(card(page)).toHaveAttribute("data-status", status, { timeout: TURN_MS });
});

Then("no inline task card is shown", async ({ page }) => {
  await page.waitForTimeout(1000);
  await expect(page.getByTestId("run-card")).toHaveCount(0);
});

Then("the inline task card shows collapsed", async ({ page }) => {
  await expect(card(page)).toBeVisible({ timeout: TURN_MS });
  await expect(header(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("run-result")).toBeHidden();
});

When("I open the inline task card", async ({ page }) => {
  await opened(page);
});

Then("the inline task card shows its result", async ({ page }) => {
  const c = await opened(page);
  await expect(c.getByTestId("run-result")).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the inline task card shows a model and a token count in its header", async ({ page }) => {
  const meta = page.getByTestId(/^run-meta(-compact)?$/).filter({ visible: true }).first();
  await expect(meta).toBeVisible({ timeout: TURN_MS });
  await expect(meta).toHaveText(/\S+ · .*\d.*tokens?/i);
});

Then("the inline task meta is its own row under the header", async ({ page }) => {
  await expect(page.getByTestId("run-meta-compact")).toBeVisible();
  await expect(page.getByTestId("run-meta")).toBeHidden();
});

Then("the inline task steps are collapsed", async ({ page }) => {
  const c = await opened(page);
  const toggle = c.getByTestId("run-steps-toggle");
  await expect(toggle).toBeVisible({ timeout: TURN_MS });
  await expect(toggle).toHaveText(/\d/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(c.getByTestId("tool-card")).toHaveCount(0);
});

When("I open the inline task steps", async ({ page }) => {
  const c = await opened(page);
  const toggle = c.getByTestId("run-steps-toggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});

Then("the inline task steps show a {string} step", async ({ page }, tool: string) => {
  const c = await opened(page);
  const toggle = c.getByTestId("run-steps-toggle");
  await expect(toggle).toBeVisible({ timeout: TURN_MS });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(card(page).getByTestId("tool-card").filter({ hasText: tool }).first()).toBeVisible({ timeout: TURN_MS });
});

Then("the inline task steps show the explored group of read and search steps", async ({ page }) => {
  const c = await opened(page);
  const toggle = c.getByTestId("run-steps-toggle");
  await expect(toggle).toBeVisible({ timeout: TURN_MS });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await expect(c.getByRole("button", { name: /Explored/ }).first()).toBeVisible();
});

Then("the inline task step {string} is {word}", async ({ page }, text: string, outcome: string) => {
  const status = STATUS[outcome];
  if (!status) throw new Error(`unknown outcome "${outcome}"`);
  const c = await opened(page);
  if ((await c.getByTestId("run-steps-toggle").count()) && (await c.getByTestId("run-steps-toggle").getAttribute("aria-expanded")) === "false") await c.getByTestId("run-steps-toggle").click();
  await expect(c.getByTestId("tool-card").filter({ hasText: text }).first()).toHaveAttribute("data-status", status, { timeout: TURN_MS });
});

Then("the inline task card lists the changed file {string}", async ({ page }, file: string) => {
  const c = await opened(page);
  await expect(c.getByTestId("run-files")).toContainText(file, { timeout: TURN_MS });
});

Then("the inline task card says the result is partial", async ({ page }) => {
  const c = await opened(page);
  await expect(c.getByTestId("run-note")).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the inline task card has a Stop button", async ({ page }) => {
  await expect(page.getByTestId("run-stop").first()).toBeVisible({ timeout: TURN_MS });
});

When("I stop the inline task", async ({ page }) => {
  await page.getByTestId("run-stop").first().click();
});

Then("the page scrollWidth equals the viewport width", async ({ page }) => {
  const m = await page.evaluate(() => ({ inner: window.innerWidth, root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(m.root).toBe(m.inner);
  expect(m.body).toBeLessThanOrEqual(m.inner);
});

// ---- @cost: model calls of the parent (and subagent) read from the Claude Code transcripts of the scratch project.

const marks = new WeakMap<Page, number>();

/** Waits until the transcript has more parent calls than `n` and the count has been stable for 3 seconds. */
async function settledCalls(project: string, n: number): Promise<Call[]> {
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const calls = parentCalls(project);
    if (calls.length > n && calls.length === last) {
      if (++stable >= 3) return calls;
    } else stable = 0;
    last = calls.length;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("the transcript did not settle");
}

When("I note the session token totals", async ({ page, project }) => {
  await expect.poll(() => parentCalls(project.name).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 3_000));
  marks.set(page, parentCalls(project.name).length);
});

When("I record the {word} cost of {string}", async ({ page, project }, engine: string, scenario: string) => {
  if (engine !== "inline" && engine !== "subagent") throw new Error(`engine must be inline or subagent, got ${engine}`);
  const n = marks.get(page);
  if (n === undefined) throw new Error("note the session token totals first");
  const all = await settledCalls(project.name, n);
  const mine = all.slice(n);
  const parentTokens = callsTotal(mine);
  let workerTokens = 0;
  let costUsd = priceOf(mine);
  let model = "haiku (Agent tool)";
  if (engine === "inline") {
    let result: InlineResult | undefined;
    await expect.poll(() => (result = inlineResults(project.name).at(-1)), { timeout: 30_000, message: "inline_task result in the transcript" }).toBeTruthy();
    expect(result!.status, "inline task finished").toBe("done");
    workerTokens = tokenSum(result!.tokens);
    costUsd += result!.costUsd ?? 0;
    model = result!.model ?? "";
  } else {
    let sub: Call[] = [];
    await expect.poll(() => (sub = subagentCalls(project.name)).length, { timeout: 30_000, message: "subagent transcript" }).toBeGreaterThan(0);
    workerTokens = callsTotal(sub);
    costUsd += priceOf(sub);
  }
  expect(parentTokens, "parent turn used tokens").toBeGreaterThan(0);
  const parentContextDelta = mine.at(-1)!.context - all[n - 1]!.context;
  writeCost(evidenceDir(runDir()), scenario, { engine, parentCalls: mine.length, parentTokens, workerTokens, totalTokens: parentTokens + workerTokens, costUsd: Number(costUsd.toFixed(5)), parentContextDelta, model, date: new Date().toISOString() });
  marks.set(page, all.length);
});

Then("the inline cost of {string} is lower than the subagent cost", async ({}, scenario: string) => {
  const e = readCosts(evidenceDir(runDir()))[scenario];
  expect(e?.inline && e?.subagent, "both runs recorded").toBeTruthy();
  expect(e!.inline!.totalTokens, `inline ${e!.inline!.totalTokens} vs subagent ${e!.subagent!.totalTokens}`).toBeLessThan(e!.subagent!.totalTokens);
});

Then("the parent context grew less with the inline task than with the subagent for {string}", async ({}, scenario: string) => {
  const e = readCosts(evidenceDir(runDir()))[scenario];
  expect(e?.inline && e?.subagent, "both runs recorded").toBeTruthy();
  expect(e!.inline!.parentContextDelta, `inline ${e!.inline!.parentContextDelta} vs subagent ${e!.subagent!.parentContextDelta}`).toBeLessThan(e!.subagent!.parentContextDelta);
});
