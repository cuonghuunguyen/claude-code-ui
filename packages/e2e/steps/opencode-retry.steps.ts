// GH-683: OpenCode's retry wait and unavailable models, against a local stub provider (no real model, no login).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { configHome, runDir } from "../support/paths.ts";
import { startStubProvider, stubOpenCodeConfig, type StubMode, type StubProvider } from "../support/stub-provider.ts";
import { TURN_MS } from "../support/ui.ts";
import { After, Given, Then, When } from "./fixtures.ts";

let stub: StubProvider | undefined;
const provider = () => {
  if (!stub) throw new Error("the stub provider is not started");
  return stub;
};

const retryMode = (status: number, seconds: number, message?: string): StubMode => ({
  kind: "retry",
  status: status as 429 | 503,
  retryAfter: seconds,
  message: message ?? (status === 429 ? "Rate limit reached for m1" : "Service Unavailable: model overloaded"),
});

// The config file is the one the slow-MCP scenarios write: its After hook ("remove the slow MCP config") removes it, and the run's config home is isolated.
async function declareProvider(model: string, mode: StubMode) {
  stub = await startStubProvider();
  stub.mode = mode;
  const dir = join(configHome(runDir()), "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(stubOpenCodeConfig(stub.port, model)));
}

Given("OpenCode has a model provider that answers {int} with a retry wait of {int} seconds", async ({}, status: number, seconds: number) => {
  await declareProvider("stub/m1", retryMode(status, seconds));
});

Given("OpenCode has a model provider that answers 503 with a retry wait of {int} seconds and a very long explanation", async ({}, seconds: number) => {
  const sentence = "the capacity of this region is exhausted and the provider asks every client to wait ";
  const message = `Service Unavailable: model overloaded, ${sentence.repeat(4)}ThisIsOneVeryLongTokenWithoutAnySpacesToCheckWrappingOnNarrowScreens${"X".repeat(60)}`;
  await declareProvider("stub/m1", retryMode(503, seconds, message));
});

Given("OpenCode has a model provider that says the model does not exist", async () => {
  await declareProvider("stub/m1", { kind: "model-404", message: "The model `m1` does not exist or you do not have access to it." });
});

Given("OpenCode is set to the model {string}, which the provider does not offer", async ({}, model: string) => {
  await declareProvider(model, { kind: "ok" });
});

When("the model provider answers {int} with a retry wait of {int} seconds", async ({}, status: number, seconds: number) => {
  provider().mode = retryMode(status, seconds);
});

When("the model provider answers OK", async () => {
  provider().mode = { kind: "ok" };
});

// After a restart OpenCode's server starts cold; the list reaches the sidebar when it answers (late push), so wait for that state, not a time.
When("the sidebar lists the restored session", async ({ page }) => {
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await expect(page.getByTestId("session-item").first()).toBeVisible({ timeout: 120_000 });
});

const retry = (page: Page) => page.getByTestId("retry-status");

Then("I see the retry state with the reason {string}", async ({ page }, reason: string) => {
  await expect(retry(page).last()).toBeVisible({ timeout: TURN_MS });
  await expect(page.getByTestId("retry-reason").last()).toContainText(reason);
});

Then("the retry state counts down to a next try", async ({ page }) => {
  await expect(page.getByTestId("retry-countdown").last()).toHaveText(/^Retrying in \d+s · attempt \d+$/, { timeout: TURN_MS });
});

Then("the retry state is shown instead of Thinking", async ({ page }) => {
  await expect(retry(page)).toHaveCount(1);
  await expect(page.getByTestId("thinking")).toHaveCount(0);
});

Then("the retry state is gone", async ({ page }) => {
  await expect(retry(page)).toHaveCount(0, { timeout: TURN_MS });
});

Then("the retry state is below the last prompt of the transcript", async ({ page }) => {
  const below = await page.evaluate(() => {
    const prompts = [...document.querySelectorAll('[data-testid="user-message"]')].filter((e) => e.getClientRects().length);
    const r = document.querySelector('[data-testid="retry-status"]');
    const last = prompts.at(-1);
    return !!r && !!last && !!(last.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(below, "the retry state follows the last user message").toBe(true);
});

Then("the transcript shows {int} user messages", async ({ page }, n: number) => {
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])')).toHaveCount(n, { timeout: TURN_MS });
});

Then("the transcript shows exactly {int} notices", async ({ page }, n: number) => {
  await expect(page.getByTestId("notice")).toHaveCount(n, { timeout: TURN_MS });
});

Then("I see the only notice containing {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("notice").filter({ hasText: text })).toHaveCount(1, { timeout: TURN_MS });
});

Then("the only notice contains {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("notice")).toHaveCount(1, { timeout: TURN_MS });
  await expect(page.getByTestId("notice")).toContainText(text);
});

Then("the only notice is readable and has no stack trace", async ({ page }) => {
  await expect(page.getByTestId("notice")).toHaveCount(1);
  const text = (await page.getByTestId("notice").innerText()).trim();
  expect(text.length, text).toBeLessThan(400);
  expect(text, "stack trace in the notice").not.toMatch(/\n\s*at\s|\bat .*:\d+:\d+|node_modules|\.ts:\d+|stack/i);
  expect(text.split("\n").length, text).toBeLessThanOrEqual(3);
});

Then("the notice {string} sits between the first and the second prompt", async ({ page }, text: string) => {
  const ok = await page.evaluate((t) => {
    const prompts = [...document.querySelectorAll('[data-testid="user-message"]')].filter((e) => e.getClientRects().length);
    const n = [...document.querySelectorAll('[data-testid="notice"]')].find((e) => e.textContent?.includes(t));
    return !!n && prompts.length >= 2 && !!(prompts[0]!.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) && !!(n.compareDocumentPosition(prompts[1]!) & Node.DOCUMENT_POSITION_FOLLOWING);
  }, text);
  expect(ok, "the notice of turn 1 sits between prompt 1 and prompt 2").toBe(true);
});

// "No retry" is a statement about the whole turn, so the page watches for the retry state from before the prompt on.
When("the page starts watching for a retry state", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __sawRetry?: boolean };
    w.__sawRetry = !!document.querySelector('[data-testid="retry-status"]');
    new MutationObserver(() => void (document.querySelector('[data-testid="retry-status"]') && (w.__sawRetry = true))).observe(document.body, { childList: true, subtree: true });
  });
});

Then("the page never showed a retry state", async ({ page }) => {
  expect(await page.evaluate(() => (window as unknown as { __sawRetry?: boolean }).__sawRetry)).toBe(false);
});

After({ name: "stop the stub model provider" }, async () => {
  await stub?.stop();
  stub = undefined;
});
