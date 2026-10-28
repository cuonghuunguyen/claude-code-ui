// Aside (/btw) steps (docs/spec.md "Aside"). The owner's locators are scoped to the session area, the popup's to [data-aside-popup]:
// with a popup open the page has two prompt boxes, send buttons and permission panels.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { openApp, openProject, prepareHaikuSession, sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { TURN_MS } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const owner = (page: Page) => page.getByTestId("session-area");
const popup = (page: Page) => page.locator("[data-aside-popup]");
const prompt = (scope: ReturnType<typeof owner>) => scope.getByRole("combobox", { name: /^(First prompt|Prompt)$/ });
const popupBox = async (page: Page) => (await popup(page).boundingBox())!;
const sessionId = (page: Page) => new URL(page.url()).hash.replace(/^#/, "").split("/")[0]!;

/** Claude Code's transcript of a session, wherever its project folder is (the folder name encodes the cwd). */
function transcriptOf(id: string): string | undefined {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return undefined;
}
const fingerprint = (file: string) => `${statSync(file).mtimeMs}:${readFileSync(file, "utf8")}`;

Given("a Haiku session that has read {string}", async ({ page, daemon, project }, name: string) => {
  writeFileSync(join(project.path, name), "x");
  await openApp(page, daemon);
  await openProject(page, project.path);
  await prepareHaikuSession(page, project.name);
  await sendPrompt(page, `Read the file ${name} with the Read tool and say only OK`);
  // Haiku sometimes makes the Read of the project file ask first: allow it, as a user would.
  await expect(async () => {
    const card = page.getByTestId("permission-panel").getByRole("button", { name: "Allow once" });
    if (await card.isVisible()) await card.click();
    await expect(page.getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: 2_000 });
  }).toPass({ timeout: TURN_MS });
  await waitTurnEnd(page);
});

Given("I note the owner transcript", async ({ page, memo }) => {
  const file = transcriptOf(sessionId(page));
  expect(file, "owner transcript exists").toBeTruthy();
  memo.layout = { owner: sessionId(page), print: fingerprint(file!) };
});

Then("the owner transcript is unchanged", async ({ memo }) => {
  const { owner: id, print } = memo.layout as { owner: string; print: string };
  expect(fingerprint(transcriptOf(id)!)).toBe(print);
});

Then("the owner transcript does not mention {string}", async ({ page }, text: string) => {
  expect(readFileSync(transcriptOf(sessionId(page))!, "utf8")).not.toContain(text);
});

When("I ask the aside {string}", async ({ page, memo }, question: string) => {
  const box = prompt(owner(page));
  await box.fill(`/btw ${question}`);
  await box.press("Enter");
  await expect(popup(page).first()).toBeVisible({ timeout: TURN_MS });
  memo.branch = await popup(page).first().getAttribute("data-aside-id") ?? undefined;
  memo.envValue = question;
});

When("I send {string} in the aside", async ({ page }, text: string) => {
  const box = prompt(popup(page));
  await box.fill(text);
  await popup(page).getByTestId("send").click();
});

When("I send {string} in the owner", async ({ page }, text: string) => {
  const box = prompt(owner(page));
  await box.fill(text);
  await owner(page).getByTestId("send").click();
});

When("I open the owner session", async ({ page, memo }) => {
  // After Focus: the popup's owner is the first session tab.
  await page.getByTestId("session-list").getByTestId("session-item").first().click();
  void memo;
});

Then("an aside popup shows", async ({ page }) => {
  await expect(popup(page)).toHaveCount(1);
  await expect(popup(page)).toBeVisible();
});

Then("no aside popup shows", async ({ page }) => {
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator("[data-aside-chip]")).toHaveCount(0);
});

Then("the aside shows a reply", async ({ page }) => {
  await expect(popup(page).getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the aside shows at least {int} replies", async ({ page }, n: number) => {
  await expect(async () => expect(await popup(page).getByTestId("assistant-text").count()).toBeGreaterThanOrEqual(n)).toPass({ timeout: TURN_MS });
});

Then("the owner timeline shows {int} prompt(s)", async ({ page }, n: number) => {
  await expect(owner(page).locator('[data-testid="user-message"]:not([data-pending])')).toHaveCount(n);
});

Then("the aside popup shows a permission request", async ({ page }) => {
  await expect(popup(page).getByTestId("permission-panel")).toBeVisible({ timeout: TURN_MS });
});

Then("the aside popup shows no permission request", async ({ page }) => {
  await expect(popup(page).getByTestId("permission-panel")).toHaveCount(0, { timeout: TURN_MS });
});

Then("the aside ran no Write or Edit tool", async ({ page }) => {
  await expect(popup(page).getByTestId("tool-card").filter({ hasText: /^(Write|Edit|NotebookEdit)\b/ })).toHaveCount(0);
});

Then("the owner shows no permission request", async ({ page }) => {
  await expect(owner(page).getByTestId("permission-panel")).toHaveCount(0);
});

Then("the owner shows a permission request", async ({ page }) => {
  await expect(owner(page).getByTestId("permission-panel")).toBeVisible({ timeout: TURN_MS });
});

When("I allow the aside permission request", async ({ page }) => {
  await popup(page).getByTestId("permission-panel").getByRole("button", { name: "Allow once" }).click({ timeout: TURN_MS });
});

When("I allow the owner permission request", async ({ page }) => {
  await owner(page).getByTestId("permission-panel").getByRole("button", { name: "Allow once" }).click({ timeout: TURN_MS });
});

Then("the owner runs the {string} tool call", async ({ page }, text: string) => {
  await expect(owner(page).getByTestId("tool-card").filter({ hasText: text }).first()).toHaveAttribute("data-status", "running", { timeout: TURN_MS });
});

Then("the owner turn has finished", async ({ page }) => {
  await expect(owner(page).locator('[data-testid="send"][data-state="idle"]')).toBeVisible({ timeout: TURN_MS });
});

Then("Focus lists a request of an aside", async ({ page }) => {
  await expect(page.getByTestId("focus-page")).toContainText("Aside:", { timeout: TURN_MS });
});

When("I drag the aside popup by {int},{int}", async ({ page, memo }, dx: number, dy: number) => {
  const b = await popupBox(page);
  memo.layout = b;
  const x = b.x + b.width / 2;
  const y = b.y + 16;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
});

Then("the aside popup has moved", async ({ page, memo }) => {
  const before = memo.layout as { x: number; y: number };
  const now = await popupBox(page);
  expect(Math.abs(now.x - before.x) + Math.abs(now.y - before.y)).toBeGreaterThan(50);
});

When("I resize the aside popup by {int},{int}", async ({ page, memo }, dx: number, dy: number) => {
  const b = await popupBox(page);
  memo.layout = b;
  // The native resize handle is the bottom-right corner.
  const x = b.x + b.width - 4;
  const y = b.y + b.height - 4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
});

Then("the aside popup has grown", async ({ page, memo }) => {
  const before = memo.layout as { width: number; height: number };
  const now = await popupBox(page);
  expect(now.width).toBeGreaterThan(before.width + 20);
  expect(now.height).toBeGreaterThan(before.height + 20);
});

When("I minimize the aside", async ({ page }) => {
  await popup(page).getByRole("button", { name: "Minimize aside" }).click();
});

Then("the aside shows as a chip", async ({ page }) => {
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator("[data-aside-chip]")).toBeVisible();
});

When("I restore the aside", async ({ page }) => {
  await page.locator("[data-aside-chip]").click();
});

Then("the aside popup fills the viewport", async ({ page }) => {
  const v = page.viewportSize()!;
  const b = await popupBox(page);
  expect([b.x, b.y, b.width, b.height]).toEqual([0, 0, v.width, v.height]);
});

When("I close the aside", async ({ page, memo }) => {
  memo.branch = (await popup(page).getAttribute("data-aside-id")) ?? undefined;
  await popup(page).getByRole("button", { name: "Close aside" }).click();
});

When("I keep the aside as a session", async ({ page, memo }) => {
  memo.branch = (await popup(page).getAttribute("data-aside-id")) ?? undefined;
  await popup(page).getByRole("button", { name: "Keep as session" }).click();
});

Given("I note the aside session", async ({ page, memo }) => {
  memo.branch = (await popup(page).getAttribute("data-aside-id")) ?? undefined;
});

Then("the aside transcript file does not exist", async ({ memo }) => {
  const id = memo.branch!;
  expect(id, "an aside id was noted").toBeTruthy();
  await expect.poll(() => transcriptOf(id), { timeout: 30_000 }).toBeUndefined();
});

Then("the kept session is open as a tab", async ({ page, memo }) => {
  await expect(async () => expect(sessionId(page)).toBe(memo.branch)).toPass({ timeout: 15_000 });
});

/** Sidebar rows titled by the Aside's question: the daemon of a run lists the projects of earlier scenarios too, so rows are matched by title. */
const asideRows = (page: Page, question: string) => page.getByTestId("session-list").getByTestId("session-item").filter({ hasText: question.slice(0, 40) });

Then("the session list shows no aside", async ({ page, memo }) => {
  await expect(asideRows(page, memo.envValue!)).toHaveCount(0);
});

Then("the session list lists the aside", async ({ page, memo }) => {
  await expect(asideRows(page, memo.envValue!)).not.toHaveCount(0, { timeout: 15_000 });
});

Then("the permission mode is {string}", async ({ page }, label: string) => {
  await expect(page.getByTestId("mode-select")).toHaveAttribute("aria-label", new RegExp(`^${label}`));
});
