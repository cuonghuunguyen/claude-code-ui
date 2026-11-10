// GH-682 / GH-681: slow MCP folders and turns OpenCode ends on its own.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { daemonOpenCodeServer } from "../support/opencode.ts";
import { RECONNECT_MS, TURN_MS, waitConnected } from "../support/ui.ts";
import { runDir } from "../support/paths.ts";
import { ownDaemon } from "./opencode-engine.steps.ts";
import { Then, When } from "./fixtures.ts";

/**
 * Another client of the daemon's OpenCode server does what the old daemon did to the folder: resets it, then drops its first read
 * (`GET /command`) after 4 s (the folder needs about 2 s to bootstrap before the MCP load starts; a 2 s cut landed before it on a loaded machine and nothing was interrupted), in the middle of the MCP load. OpenCode keeps that interruption as the folder's state.
 */
When("another client cuts OpenCode's MCP load in the project", async ({ project }) => {
  const { url, auth } = daemonOpenCodeServer(runDir(), ownDaemon());
  const q = `?directory=${encodeURIComponent(project.path)}`;
  const dispose = await fetch(`${url}/instance/dispose${q}`, { method: "POST", headers: { authorization: auth } });
  expect(dispose.ok).toBe(true);
  await fetch(`${url}/command${q}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(4000) }).then(
    () => {
      throw new Error("GET /command answered within 4 s: the MCP load was not slow, nothing was cut");
    },
    () => undefined,
  );
});

When("I restart the daemon of the OpenCode scenario", async ({ page }) => {
  const status = page.getByTestId("connection-status").first();
  const lost = expect(status).not.toHaveText(/^\s*connected\s*$/, { timeout: RECONNECT_MS });
  const daemon = ownDaemon()!;
  // The test stops the daemon by killing its tree (like a crash): OpenCode leaves its folder lock behind and the next server waits about a minute for it to go stale.
  const restart = async () => {
    await daemon.stop();
    rmSync(join(runDir(), "opencode-state", "opencode", "locks"), { recursive: true, force: true });
    await daemon.restart();
  };
  const [restarted, seen] = await Promise.allSettled([restart(), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
  await waitConnected(page);
});

Then("I see at least {int} replies from Claude", async ({ page }, n: number) => {
  await expect.poll(() => page.getByTestId("assistant-text").count(), { timeout: TURN_MS }).toBeGreaterThanOrEqual(n);
});

Then("I see the warning {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("notice").filter({ hasText: text }).first()).toBeVisible({ timeout: TURN_MS });
});

Then("the turn footer says error", async ({ page }) => {
  await expect(page.getByTestId("turn-result").last()).toContainText("error", { timeout: TURN_MS });
});

// The run's config home is shared by its scenarios, so a scenario that enabled orchestration leaves it on for the next one.
When("I disable orchestration in Settings", async ({ page }) => {
  await page.locator('[data-testid="open-settings"]:visible').first().click();
  await page.getByTestId("settings-group-orchestration").click();
  const toggle = page.getByTestId("settings-orchestration-enabled");
  if ((await toggle.getAttribute("aria-checked")) !== "false") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

// An opened session leaves the first-prompt composer of the project in the DOM (disabled, hidden): talk to the visible pair only.
When("I send {string} in the opened session", async ({ page }, text: string) => {
  await page.getByRole("combobox", { name: /^(First prompt|Prompt)$/ }).locator("visible=true").first().fill(text);
  const send = page.locator('[data-testid="send"]:visible');
  await expect(send).toBeEnabled();
  await send.click();
});

Then("the opened session's turn has finished", async ({ page }) => {
  await expect(page.locator('[data-testid="send"][data-state="idle"]:visible')).toBeVisible({ timeout: TURN_MS });
});

// GH-682 review: Stop while send() waits for the attach (the folder's MCP load runs for 8 s).
let stoppedAt = 0;
When("I stop the turn as soon as it can be stopped", async ({ page }) => {
  const stop = page.getByTestId("toolbar-stop");
  await expect(stop).toBeVisible({ timeout: 30_000 });
  stoppedAt = Date.now();
  await stop.click();
});

Then("the turn is interrupted within {int} seconds", async ({ page }, s: number) => {
  await expect(page.getByTestId("turn-interrupted")).toBeVisible({ timeout: s * 1000 });
  console.log(`interrupted ${Date.now() - stoppedAt} ms after Stop`);
  await expect(page.locator('[data-testid="send"][data-state="idle"]:visible')).toBeVisible({ timeout: s * 1000 });
});

Then("the transcript has exactly {int} replies from Claude", async ({ page }, n: number) => {
  await expect(page.getByTestId("assistant-text")).toHaveCount(n);
});

Then("OpenCode stored the user prompt {string} and never {string}", async ({ project }, wanted: string, dropped: string) => {
  const { url, auth } = daemonOpenCodeServer(runDir(), ownDaemon());
  const q = `directory=${encodeURIComponent(project.path)}`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}${q}`, { headers: { authorization: auth } });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
  const sessions = await get<{ id: string }[]>("/session?roots=true");
  const texts: string[] = [];
  for (const s of sessions) {
    const messages = await get<{ info: { role: string }; parts: { type: string; text?: string }[] }[]>(`/session/${s.id}/message`);
    for (const m of messages) if (m.info.role === "user") texts.push(m.parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join(""));
  }
  expect(texts.some((t) => t.includes(wanted)), `user messages: ${JSON.stringify(texts)}`).toBe(true);
  expect(texts.some((t) => t.includes(dropped)), `user messages: ${JSON.stringify(texts)}`).toBe(false);
});
