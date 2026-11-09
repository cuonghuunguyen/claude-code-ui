import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { waitConnected } from "../support/ui.ts";
import { ownDaemon } from "./opencode-engine.steps.ts";
import { Given, Then, When } from "./fixtures.ts";

const agent = (page: Page) => page.getByTestId("agent-select");
const mode = (page: Page) => page.getByTestId("mode-select");
/** A phone keeps agent, mode and model behind one button: opens it (only when its popup is not open yet). */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if ((await s.isVisible()) && !(await page.getByTestId("session-settings-popup").isVisible())) await s.click();
};
const optionNames = async (page: Page) => (await page.getByRole("listbox").getByRole("option").allTextContents()).map((s) => s.trim());

Given("the OpenCode project has a primary agent {string} that cannot edit", async ({ project }, name: string) => {
  // No $schema: OpenCode would fetch it and stall offline.
  const cfg = { agent: { [name]: { description: "Reviews code, never edits", mode: "primary", permission: { edit: "deny", bash: "ask" } } } };
  writeFileSync(join(project.path, "opencode.json"), JSON.stringify(cfg));
});

// Not a user step: starts the daemon's OpenCode server before the app asks for the agents (a cold server answers the first agents request too late, see the report).
Given("the OpenCode server has started", async ({ project }) => {
  const WS = createRequire(import.meta.url)("ws");
  const d = ownDaemon()!;
  const ask = (id: string) =>
    new Promise<string>((res) => {
      const ws = new WS(`ws://127.0.0.1:${d.port}/ws`, ["claude-ui", `token.${d.token}`], { origin: d.origin });
      ws.on("message", (m: Buffer) => { const j = JSON.parse(String(m)); if (j.reqId === id) (res(j.type), ws.close()); });
      ws.on("open", () => ws.send(JSON.stringify({ type: "session.agents", cwd: project.path, engine: "opencode", reqId: id })));
      setTimeout(() => res("timeout"), 30_000);
    });
  // The first requests after a cold start can run into the daemon's 3 s limit; ask until one is answered.
  await expect.poll(() => ask(`warm${Date.now()}`), { timeout: 90_000, intervals: [1_000] }).toBe("reply");
});

When("I open the agent chooser", async ({ page }) => {
  await settingsOpen(page);
  await expect(agent(page)).toBeVisible({ timeout: 120_000 });
  await agent(page).click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the agent chooser offers exactly {string}", async ({ page }, list: string) => {
  const names = await optionNames(page);
  const want = list.split(", ");
  expect(names.length).toBe(want.length);
  want.forEach((w, i) => expect(names[i]).toMatch(new RegExp(`^${w}`)));
});

Then("the agent chooser comes before the permission chooser", async ({ page }) => {
  const [a, m] = [await agent(page).boundingBox(), await mode(page).boundingBox()];
  expect(a && m).toBeTruthy();
  expect(a!.x).toBeLessThan(m!.x);
});

When("I open the permission chooser", async ({ page }) => {
  await settingsOpen(page);
  await expect(mode(page)).toBeVisible({ timeout: 120_000 });
  await mode(page).click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the permission chooser offers exactly {string}", async ({ page }, list: string) => {
  expect(await optionNames(page)).toEqual(list.split(", "));
});

When("I pick the agent {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await expect(agent(page)).toBeVisible({ timeout: 120_000 });
  await agent(page).click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(agent(page)).toContainText(name);
});

When("I pick the permission mode {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await mode(page).click();
  await page.getByRole("option", { name }).click();
  await expect(mode(page)).toHaveAttribute("aria-label", /^Permission mode/);
  await expect(mode(page)).toContainText(name);
});

Then("the agent chooser shows {string}", async ({ page }, name: string) => {
  await settingsOpen(page);
  await expect(agent(page)).toContainText(name, { timeout: 120_000 });
});

When("I restart the OpenCode daemon", async ({ page }) => {
  const lost = expect(page.getByTestId("connection-status").first()).not.toHaveText(/^\s*connected\s*$/, { timeout: 60_000 });
  const [restarted, seen] = await Promise.allSettled([ownDaemon()!.restart(), lost]);
  if (restarted.status === "rejected") throw restarted.reason;
  if (seen.status === "rejected") throw seen.reason;
  await waitConnected(page);
});

When("I open the agent and permission choosers", async ({ page }) => {
  await settingsOpen(page);
});

Then("both choosers are visible", async ({ page }) => {
  await expect(agent(page)).toBeVisible({ timeout: 120_000 });
  await expect(mode(page)).toBeVisible();
});

Then("each chooser is at least 44px tall on a phone", async ({ page, $testInfo }) => {
  if (!(await page.getByTestId("session-settings").isVisible())) return void $testInfo.annotations.push({ type: "desktop", description: "no phone settings button at this width" });
  for (const c of [agent(page), mode(page)]) expect((await c.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

Then("there is no agent chooser", async ({ page }) => {
  await expect(mode(page)).toBeVisible();
  await expect(agent(page)).toHaveCount(0);
});
