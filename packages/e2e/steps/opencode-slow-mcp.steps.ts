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
 * (`GET /command`) after 2 s, in the middle of the MCP load. OpenCode keeps that interruption as the folder's state.
 */
When("another client cuts OpenCode's MCP load in the project", async ({ project }) => {
  const { url, auth } = daemonOpenCodeServer(ownDaemon()!.pid);
  const q = `?directory=${encodeURIComponent(project.path)}`;
  const dispose = await fetch(`${url}/instance/dispose${q}`, { method: "POST", headers: { authorization: auth } });
  expect(dispose.ok).toBe(true);
  await fetch(`${url}/command${q}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(2000) }).then(
    () => {
      throw new Error("GET /command answered within 2 s: the MCP load was not slow, nothing was cut");
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
