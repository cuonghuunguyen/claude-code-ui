import { expect } from "@playwright/test";
import { TURN_MS, toolCard } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

const button = (page: Parameters<typeof toolCard>[0], text: string) => toolCard(page, text).getByTestId("run-in-background");
const shells = (page: Parameters<typeof toolCard>[0]) => page.locator('[data-field="shells"]');

// The CLI registers the foreground task after about 3 s: the button shows then, not before.
When("I click Run in background on the {string} tool card", async ({ page, memo }, text: string) => {
  const b = button(page, text);
  await expect(b).toBeVisible({ timeout: 30_000 });
  memo.texts = await page.getByTestId("assistant-text").count();
  await b.click();
});

When("the Run in background button shows on the {string} tool card", async ({ page, memo }, text: string) => {
  await expect(button(page, text)).toBeVisible({ timeout: 30_000 });
  memo.texts = await page.getByTestId("assistant-text").count();
});

Then("the Run in background button is at least 44 px on the {string} tool card", async ({ page }, text: string) => {
  const box = await button(page, text).boundingBox();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

When("I note the reply count", async ({ page, memo }) => {
  memo.texts = await page.getByTestId("assistant-text").count();
});

Then("the status bar shows {string}", async ({ page }, text: string) => {
  await expect(shells(page)).toContainText(text, { timeout: 15_000 });
});

Then("the status bar shows no shells", async ({ page }) => {
  await expect(shells(page)).toHaveCount(0, { timeout: 60_000 });
});

Then("Claude replies after the shell ended", async ({ page, memo }) => {
  await expect.poll(() => page.getByTestId("assistant-text").count(), { timeout: TURN_MS }).toBeGreaterThan(memo.texts ?? 0);
});

// The count is noted before the prompt that frees the session: its reply and the reply to the end notice are the two.
Then("Claude has replied {int} times since the noted count", async ({ page, memo }, n: number) => {
  await expect.poll(() => page.getByTestId("assistant-text").count(), { timeout: TURN_MS }).toBeGreaterThanOrEqual((memo.texts ?? 0) + n);
});

// Absent means absent after the registration delay too, so wait past it first.
Then("the {string} tool card has no Run in background button", async ({ page }, text: string) => {
  await expect(toolCard(page, text)).toBeVisible();
  await page.waitForTimeout(6_000);
  await expect(button(page, text)).toHaveCount(0);
});

Then("the {string} tool card has no Run in background button right away", async ({ page }, text: string) => {
  await expect(button(page, text)).toHaveCount(0);
});

// Bash mode (GH-485): the card of a `!` command has a button at once (no registration delay).
const lastBashCard = (page: Parameters<typeof toolCard>[0]) => page.getByTestId("bash-card").last();

When("I click Run in background on the bash card", async ({ page }) => {
  const b = lastBashCard(page).getByTestId("run-in-background");
  await expect(b).toBeVisible();
  await b.click();
});

Then("the bash card runs in the background", async ({ page }) => {
  const card = lastBashCard(page);
  await expect(card).toHaveAttribute("data-shell", "background");
  await expect(card).toHaveAttribute("data-status", "running");
  await expect(card.getByTestId("run-in-background")).toHaveCount(0);
});

Then("the bash card is finished", async ({ page }) => {
  await expect(lastBashCard(page)).toHaveAttribute("data-status", /^(done|error)$/, { timeout: 60_000 });
});

// Acceptance additions (GH-485 / GH-492).
Then("no Claude reply starts for {int} seconds", async ({ page, memo }, s: number) => {
  await page.waitForTimeout(s * 1000);
  expect(await page.getByTestId("assistant-text").count()).toBe(memo.texts ?? 0);
  await expect(page.locator('[data-testid="send"][data-state="idle"]:visible')).toHaveCount(1);
});

Then("the shell output starts with the truncation marker and ends with {string}", async ({ page }, last: string) => {
  const out = page.getByTestId("shells-dialog").getByTestId("shell-output");
  // The list shows the last 20 lines until expanded; the marker is the first line of the tail.
  const more = out.getByRole("button", { name: /^Show all \d+ lines$/ });
  await expect(more).toBeVisible({ timeout: 60_000 });
  await more.click();
  await expect(out).toContainText("showing the last 30000 characters", { timeout: 60_000 });
  await expect(out).toContainText(last);
  const text = (await out.innerText()).replace(/\s+/g, " ");
  expect(text).not.toMatch(/\btick-1\b/);
  expect(text).not.toMatch(/\b1 2 3 4 5 6 7 8 9 10 /);
});

// Claude may ask before a subagent's Bash runs: allow while waiting for the card button.
When("I move the subagent Bash call {string} to the background", async ({ page, memo }, text: string) => {
  const b = button(page, text);
  const end = Date.now() + 180_000;
  while (Date.now() < end && !(await b.first().isVisible())) {
    const allowBtn = page.getByTestId("permission-panel").getByRole("button", { name: "Allow once" });
    if (await allowBtn.isVisible()) await allowBtn.click();
    await page.waitForTimeout(500);
  }
  await expect(b.first()).toBeVisible({ timeout: 1_000 });
  await b.first().click();
});

Then("the status bar shows a shell within a minute", async ({ page }) => {
  await expect(shells(page)).toContainText("shell", { timeout: 60_000 });
});

Then("the chat shows a reply containing {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("assistant-text").filter({ hasText: text }).first()).toBeVisible({ timeout: 30_000 });
});
