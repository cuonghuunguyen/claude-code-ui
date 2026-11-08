// OpenCode parity features (GH-658): rewind, slash commands, hidden Claude-only controls, orchestration attach, aside.
import { expect, type Locator, type Page } from "@playwright/test";
import { daemonOpenCodeServer } from "../support/opencode.ts";
import { promptBox } from "../support/ui.ts";
import { ownDaemon } from "./opencode-engine.steps.ts";
import { Then, When } from "./fixtures.ts";

const userMessage = (page: Page, text: string): Locator => page.getByTestId("user-message").filter({ hasText: text });
const panel = (page: Page) => page.getByTestId("rewind-panel");
const commands = (page: Page) => page.getByRole("listbox", { name: "Commands and skills" });
const popup = (page: Page) => page.locator("[data-aside-popup]");

/** A request to the OpenCode server of this scenario's daemon (the one the app uses). */
async function opencode<T>(path: string, directory: string): Promise<T> {
  const { url, auth } = daemonOpenCodeServer(ownDaemon()!.pid);
  const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

// The daemon lists OpenCode sessions only once its OpenCode server runs (picking the engine loads its models: no model turn).
Then("the OpenCode server of the daemon is running", async () => {
  await expect(async () => void daemonOpenCodeServer(ownDaemon()!.pid)).toPass({ timeout: 60_000 });
});

When("I open the rewind panel of the message {string}", async ({ page }, text: string) => {
  const row = userMessage(page, text).first();
  await row.hover();
  await row.getByRole("button", { name: "Rewind to before this message" }).click();
  await expect(panel(page)).toBeVisible();
});

Then("the rewind panel offers exactly {string}", async ({ page }, list: string) => {
  // The panel shows "Checking" until the preview arrived.
  await expect(panel(page)).not.toContainText(/checking/i, { timeout: 30_000 });
  const names = (await panel(page).getByRole("button").allTextContents()).map((s) => s.trim());
  expect(names).toEqual(list.split(", "));
});

When("I choose {string} in the rewind panel", async ({ page }, name: string) => {
  await panel(page).getByRole("button", { name, exact: true }).click();
});

Then("the conversation does not show the user message {string}", async ({ page }, text: string) => {
  await expect(userMessage(page, text)).toHaveCount(0, { timeout: 30_000 });
});

Then("the prompt box holds {string}", async ({ page }, text: string) => {
  await expect.poll(() => promptBox(page).inputValue(), { timeout: 15_000 }).toContain(text);
});

Then("the commands popup lists {string} and {string} with descriptions", async ({ page }, a: string, b: string) => {
  const list = commands(page);
  await expect(list).toBeVisible({ timeout: 30_000 });
  for (const name of [a, b]) {
    const row = list.getByRole("option").filter({ hasText: new RegExp(`^/${name}(?![\\w-])`) });
    await expect(row).toHaveCount(1);
    // name, optional hint, description: the row has text after the name.
    await expect(row.locator("span").last()).toHaveText(/\S/);
  }
});

When("I select the highlighted command with the keyboard", async ({ page }) => {
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
});

Then("the commands popup is closed", async ({ page }) => {
  await expect(commands(page)).toHaveCount(0);
});

Then("the toolbar shows no plan meter, no account switcher and no effort chooser", async ({ page }) => {
  const area = page.getByTestId("session-area");
  await expect(area.getByTestId("prompt-toolbar")).toBeVisible();
  for (const id of ["plan-meter", "plan-account", "effort-select"]) await expect(area.getByTestId(id)).toHaveCount(0);
});

Then("typing {string} in the prompt box does not start bash mode", async ({ page }, text: string) => {
  await promptBox(page).click();
  await page.keyboard.type(text);
  await expect.poll(() => promptBox(page).inputValue()).toContain(text);
  await expect(page.getByTestId("bash-mode")).toHaveCount(0);
});

Then("the OpenCode server lists a connected orchestration MCP for the project", async ({ project }) => {
  await expect(async () => {
    const status = await opencode<Record<string, { status: string }>>("/mcp", project.path);
    const own = Object.entries(status).filter(([name]) => name.startsWith("orchestration-"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.map(([, v]) => v.status)).toContain("connected");
  }).toPass({ timeout: 60_000 });
});

Then("the OpenCode server lists {int} session(s) for the project", async ({ project }, n: number) => {
  await expect(async () => {
    const list = await opencode<{ id: string }[]>("/session", project.path);
    expect(list).toHaveLength(n);
  }).toPass({ timeout: 30_000 });
});

Then("the aside popup answers with a reply", async ({ page }) => {
  await expect(popup(page)).toHaveCount(1);
  await expect(popup(page).getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: 120_000 });
});

When("I ask the aside {string} from the palette", async ({ page }, question: string) => {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill("Ask aside");
  await palette.getByRole("option", { name: /Ask aside/i }).first().click();
  const box = promptBox(page);
  await expect.poll(() => box.inputValue()).toContain("/btw");
  await page.keyboard.type(question);
  await page.keyboard.press("Enter");
  await expect(popup(page).first()).toBeVisible({ timeout: 60_000 });
});
