import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../support/daemon.ts";
import { expect } from "@playwright/test";
import { sendPrompt } from "../support/flow.ts";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

// Never logs in or out: the run uses the owner's real CLI credentials. The terminal opened by the login button is closed unfinished.
let replies = 0;
const replyCount = (page: import("@playwright/test").Page) => page.getByTestId("assistant-text").count();

When("I add the Claude token account {string} with the token {string} in Settings and pick it", async ({ page }, name: string, token: string) => {
  // A phone shows the sidebar, and its Settings button, in a drawer.
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-account").click();
  await page.getByTestId("settings-account-name").fill(name);
  await page.getByTestId("settings-account-token").fill(token);
  await page.getByTestId("settings-account-add").click();
  await expect(page.getByTestId("settings-account-token-set")).toBeVisible();
  await page.getByTestId("settings-account-option").filter({ hasText: name }).click();
  await expect(page.getByTestId("settings-account-option").filter({ hasText: name })).toHaveAttribute("aria-checked", "true");
  expect(await page.getByTestId("settings-account").innerText()).not.toContain(token);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

When("I send the prompt {string}", async ({ page }, text: string) => {
  replies = await replyCount(page);
  await sendPrompt(page, text);
});

Then("the timeline warns {string} and offers {string}", async ({ page }, error: string, action: string) => {
  const row = page.getByTestId("raw-part").filter({ hasText: error });
  await expect(row.first()).toBeVisible({ timeout: TURN_MS });
  await expect(row.first().getByTestId("claude-login")).toHaveText(action);
});

When("I use the {string} button of the warning", async ({ page }, label: string) => {
  await page.getByRole("button", { name: label }).first().click();
});

Then("a terminal titled {string} shows output", async ({ page }, title: string) => {
  const tab = page.getByTestId("terminal-tab").filter({ hasText: title });
  await expect(tab.first()).toBeVisible({ timeout: 30_000 });
  // Structure only: the CLI printed something (its own login prompt).
  await expect(page.getByTestId("terminal-view").locator(".xterm-rows").first()).toHaveText(/\S/, { timeout: 30_000 });
});

When("I close the Claude login terminal", async ({ page }) => {
  await page.getByRole("button", { name: /^Close .*Claude login/ }).first().click();
  await expect(page.getByTestId("terminal-tab").filter({ hasText: "Claude login" })).toHaveCount(0);
});

Then("the page does not scroll sideways", async ({ page }) => {
  const m = await page.evaluate(() => ({ inner: window.innerWidth, root: document.documentElement.scrollWidth }));
  expect(m.root).toBe(m.inner);
});

When("I open the usage ring", async ({ page }) => {
  await page.getByTestId("plan-meter").click();
  await expect(page.getByTestId("plan-usage")).toBeVisible();
});

Then("the usage popover names the account {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("plan-account")).toHaveText(`Account: ${name}`);
});

Then("the account list checks {string} and offers {string}", async ({ page }, on: string, other: string) => {
  const rows = page.getByTestId("plan-account-option");
  await expect(rows.filter({ hasText: on })).toHaveAttribute("aria-checked", "true");
  await expect(rows.filter({ hasText: other })).toHaveAttribute("aria-checked", "false");
});

Then("the account list checks {string}", async ({ page }, on: string) => {
  await expect(page.getByTestId("plan-account-option").filter({ hasText: on })).toHaveAttribute("aria-checked", "true");
});

When("I switch to {string} in the usage ring", async ({ page }, name: string) => {
  await page.getByTestId("plan-account-option").filter({ hasText: name }).click();
});

Then("the usage ring is in the titlebar", async ({ page }) => {
  await expect(page.getByTestId("plan-meter")).toBeVisible();
});

Then("a new Claude reply is shown", async ({ page }) => {
  await expect.poll(() => replyCount(page), { timeout: TURN_MS }).toBeGreaterThan(replies);
});

Then("the usage popover is inside the viewport", async ({ page }) => {
  const box = await page.getByTestId("plan-usage").boundingBox();
  const vp = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
});

// The scenarios share one daemon: the token accounts are removed at the end (removing the active one falls back to Default).
When("I remove the Claude token accounts", async ({ page }) => {
  await page.keyboard.press("Escape");
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-account").click();
  const remove = page.getByTestId("settings-account-remove");
  while (await remove.count()) {
    const n = await remove.count();
    await remove.first().click();
    await expect(remove).toHaveCount(n - 1);
  }
  // Removing the active account falls back to Default (the first row); no-op check when none was active.
  await expect(page.getByTestId("settings-account-option").first()).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

Then("the failed turn shows exactly one {string} warning", async ({ page }, error: string) => {
  // Let a late duplicate row arrive before counting.
  await page.waitForTimeout(2000);
  await expect(page.getByTestId("raw-part").filter({ hasText: error })).toHaveCount(1);
});

When("I use the Claude login button in Settings", async ({ page }) => {
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-account").click();
  await page.getByTestId("settings-claude-login").click();
  await page.keyboard.press("Escape");
});

// Frames of the page's websocket(s) from here on (a reload makes the page connect again under the listener).
const frames: { dir: "sent" | "recv"; data: string }[] = [];
When("I record the websocket frames", async ({ page }) => {
  frames.length = 0;
  page.on("websocket", (ws) => {
    ws.on("framesent", (f) => frames.push({ dir: "sent", data: String(f.payload) }));
    ws.on("framereceived", (f) => frames.push({ dir: "recv", data: String(f.payload) }));
  });
  await page.reload();
  await expect(page.getByTestId("assistant-text").first()).toBeVisible({ timeout: 30_000 });
});

Then("the Claude account list shows {string} and the token field is empty", async ({ page }, note: string) => {
  await page.keyboard.press("Escape");
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-account").click();
  await expect(page.getByTestId("settings-account-token-set")).toHaveText(note);
  await expect(page.getByTestId("settings-account-token")).toHaveValue("");
  expect(await page.getByTestId("settings-account").innerText()).not.toContain("TESTSECRET");
  await page.getByTestId("settings-account").screenshot();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

Then("the usage ring label names the account {string}", async ({ page }, name: string) => {
  const m = page.getByTestId("plan-meter");
  await expect(m).toHaveAttribute("aria-label", new RegExp(`${name}:`));
});

Then("the models are requested again", async () => {
  const n = () => frames.filter((f) => f.dir === "sent" && f.data.includes('"models.list"')).length;
  const before = n();
  expect(before).toBeGreaterThan(0);
  // The first request is the page load; a switch asks again.
  await expect.poll(n, { timeout: 15_000 }).toBeGreaterThan(1);
});

When("I pick the Claude account {string} in Settings", async ({ page }, name: string) => {
  await page.keyboard.press("Escape");
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  await page.getByTestId("open-settings").last().click();
  await page.getByTestId("settings-group-account").click();
  await page.getByTestId("settings-account-option").filter({ hasText: name }).click();
  await expect(page.getByTestId("settings-account-option").filter({ hasText: name })).toHaveAttribute("aria-checked", "true");
});

Then("the account list is not offering {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("plan-account-option").filter({ hasText: name })).toHaveCount(0);
});

Then("the token appears in no websocket frame, daemon log or web bundle", async ({ daemon }) => {
  const secret = "TESTSECRET";
  expect(frames.length).toBeGreaterThan(0);
  // The page sends the token once, in claude.account.add; nothing else sent and nothing received may carry it.
  const leaks = frames.filter((f) => f.data.includes(secret) && !(f.dir === "sent" && f.data.includes('"claude.account.add"')));
  expect(leaks.map((f) => f.dir)).toEqual([]);
  expect(frames.filter((f) => f.dir === "sent" && f.data.includes(secret)).length).toBe(1);
  expect(readFileSync(daemon.log, "utf8")).not.toContain(secret);
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (readFileSync(p).includes(secret)) hits.push(p);
    }
  };
  walk(join(REPO_ROOT, "packages", "web", "dist"));
  expect(hits).toEqual([]);
});
