// OpenCode parity features (GH-658): rewind, slash commands, hidden Claude-only controls, orchestration attach, aside.
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { daemonOpenCodeServer } from "../support/opencode.ts";
import { promptBox } from "../support/ui.ts";
import { ownDaemon } from "./opencode-engine.steps.ts";
import { runDir } from "../support/paths.ts";
import { After, Given, Then, When } from "./fixtures.ts";

const userMessage = (page: Page, text: string): Locator => page.getByTestId("user-message").filter({ hasText: text });
const panel = (page: Page) => page.getByTestId("rewind-panel");
const commands = (page: Page) => page.getByRole("listbox", { name: "Commands and skills" });
const popup = (page: Page) => page.locator("[data-aside-popup]");

/** A request to the OpenCode server of this scenario's daemon (the one the app uses). */
async function opencode<T>(path: string, directory: string): Promise<T> {
  const { url, auth } = daemonOpenCodeServer(runDir());
  const res = await fetch(`${url}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return (await res.json()) as T;
}

// The daemon lists OpenCode sessions only once its OpenCode server runs (picking the engine loads its models: no model turn).
Then("the OpenCode server of the daemon is running", async () => {
  await expect(async () => void daemonOpenCodeServer(runDir())).toPass({ timeout: 60_000 });
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

Then("I see no notice {string}", async ({ page }, text: string) => {
  await expect(page.getByText(text, { exact: false })).toHaveCount(0);
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

When("I steer the running turn with {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("toolbar-stop")).toBeVisible({ timeout: 60_000 });
  await promptBox(page).fill(text);
  await promptBox(page).press("Enter");
});

Then("the turn stays finished", async ({ page }) => {
  // One turn ends once: after the end, no new run starts.
  await page.waitForTimeout(5_000);
  await expect(page.getByTestId("toolbar-stop")).toHaveCount(0);
});

Then("the context meter shows a value", async ({ page }) => {
  await expect(page.getByTestId("session-area").getByTestId("context-meter")).toHaveText(/\d+%/, { timeout: 30_000 });
});

// GH-665 follow-ups.
Then("the conversation shows no assistant reply", async ({ page }) => {
  await expect(page.getByTestId("assistant-text")).toHaveCount(0);
});

Then("the commands popup offers {string}, {string} and {string}", async ({ page }, a: string, b: string, c: string) => {
  await expect(commands(page)).toBeVisible({ timeout: 30_000 });
  for (const name of [a, b, c]) await expect(commands(page).getByRole("option").filter({ has: page.getByText(`/${name}`, { exact: true }) })).toHaveCount(1);
});

// Enter picks the highlighted command while the popup is open, the next Enter sends it.
When("I send the slash command {string}", async ({ page }, text: string) => {
  await promptBox(page).fill(text);
  for (let i = 0; i < 3 && (await promptBox(page).inputValue()) !== ""; i++) await promptBox(page).press("Enter");
  await expect(promptBox(page)).toHaveValue("");
});

/** A phone keeps mode, model and effort behind one button. */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if (await s.isVisible()) await s.click();
};

When("I pick the OpenCode model {string} in the model chooser", async ({ page }, name: string) => {
  await settingsOpen(page);
  await page.getByTestId("session-model").click();
  await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

When("I open the effort chooser", async ({ page }) => {
  await settingsOpen(page);
  await page.getByTestId("effort-select").click();
  await expect(page.getByRole("option").first()).toBeVisible();
});

Then("the effort chooser offers {string}", async ({ page }, list: string) => {
  // The model chooser may still fade out: the effort list is the one without models.
  const options = page.getByRole("listbox").filter({ hasNotText: /Pickle/ }).getByRole("option");
  await expect.poll(async () => (await options.allTextContents()).map((s) => s.trim())).toEqual(list.split(", "));
});

Then("the effort chooser is hidden for this model", async ({ page }) => {
  await settingsOpen(page);
  await expect(page.getByTestId("mode-select")).toBeVisible();
  await expect(page.getByTestId("effort-select")).toHaveCount(0);
});

Then("the prompt box asks {string}", async ({ page }, engine: string) => {
  await expect(promptBox(page)).toHaveAttribute("placeholder", new RegExp(`^Ask ${engine}(…| in .*…)`));
});

Then("the engine error text shows once", async ({ page }) => {
  const error = page.getByTestId("engine-error");
  await expect(error).toHaveCount(1);
  await expect(page.getByText(/OpenCode is not installed/)).toHaveCount(1);
  await expect(page.getByText(/Prompt not sent/)).toHaveCount(0);
});

Then("the OpenCode path setting {string} is refused under the field", async ({ page }, path: string) => {
  const input = page.getByTestId("settings-opencode-path");
  await input.fill(path);
  await input.press("Enter");
  await expect(page.getByTestId("settings-opencode-path-error")).toContainText(/absolute path/);
  await expect(page.getByRole("alert")).toHaveCount(1);
});

// OpenCode runs a ! command as a Bash tool call: a collapsed card, the output behind its header.
Then("the Bash card of {string} shows the output {string}", async ({ page }, command: string, output: string) => {
  const head = page.getByRole("button", { name: new RegExp(`^Bash ${command}`) });
  await expect(head).toBeVisible({ timeout: 60_000 });
  await expect(head).toHaveAccessibleName(/Completed/, { timeout: 60_000 });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(page.getByText(output, { exact: true })).toBeVisible();
});

Then("the shell command has ended", async ({ page }) => {
  await expect(page.getByTestId("toolbar-stop")).toHaveCount(0);
});

// The owner's OpenCode login: E2E_OPENCODE_AUTH names a copy of the auth file. It is copied unread into the run's own OpenCode data dir and deleted after the scenario.
// Before "OpenCode is set up": its new-session tab may start the server at once (the run keeps the last Engine), which reads the login at start.
const authCopy = () => join(runDir(), "opencode-data", "opencode", "auth.json");
Given("OpenCode has the owner's login", async ({ $test }) => {
  const src = process.env.E2E_OPENCODE_AUTH;
  $test.skip(!src, "E2E_OPENCODE_AUTH is not set: point it at an OpenCode auth file to run the model scenarios");
  mkdirSync(dirname(authCopy()), { recursive: true });
  copyFileSync(src!, authCopy());
  chmodSync(authCopy(), 0o600);
});
After({ name: "delete the OpenCode login copy" }, async () => {
  try {
    rmSync(authCopy(), { force: true });
  } catch {}
});

Then("the conversation shows an assistant reply after the user message {string}", async ({ page }, text: string) => {
  await expect(async () => {
    const order = await page.locator('[data-testid="user-message"], [data-testid="assistant-text"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-testid")}:${e.textContent ?? ""}`));
    const at = order.reduce((last, o, i) => (o.startsWith("user-message:") && o.includes(text) ? i : last), -1);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(order.slice(at + 1).some((o) => /^assistant-text:\s*\S/.test(o))).toBe(true);
  }).toPass({ timeout: 120_000 });
});

Then("the transcript shows a compaction marker", async ({ page }) => {
  await expect(page.getByTestId("compaction")).toBeVisible({ timeout: 120_000 });
});
