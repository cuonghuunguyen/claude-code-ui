import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { freePort, ownerPorts, startDaemon, type Daemon } from "../support/daemon.ts";
import { openApp, openProject, sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { runDir } from "../support/paths.ts";
import { openSettings, TURN_MS } from "../support/ui.ts";
import { writeReplyTranscript } from "../support/fake-transcript.ts";
import { After, Given, Then, When } from "./fixtures.ts";

// The fence script tries each way out of the sandbox and writes the outcome into its own DOM. No quotes-in-markdown or backticks inside.
const PROBE = [
  '<div id="o" style="padding:8px;border:1px solid var(--border)">pending</div>',
  "<script>",
  "var r = {};",
  'try { r.parent = parent.document ? "open" : "blocked"; } catch (e) { r.parent = "blocked"; }',
  'try { localStorage.getItem("x"); r.ls = "open"; } catch (e) { r.ls = "blocked"; }',
  'try { r.cookie = typeof document.cookie === "string" ? "open" : "blocked"; } catch (e) { r.cookie = "blocked"; }',
  "function done() { document.getElementById('o').textContent = 'parent:' + r.parent + ' ls:' + r.ls + ' cookie:' + r.cookie + ' fetch:' + r.fetch; }",
  'fetch("/").then(function () { r.fetch = "open"; done(); }, function () { r.fetch = "blocked"; done(); });',
  "</script>",
].join("\n");

let own: Daemon | undefined;
let transcript: string | undefined;
let bg = "";

const frame = (page: Page) => page.getByTestId("visualize-frame").last();
const inner = (page: Page) => page.frameLocator('[data-testid="visualize-frame"]').last();

Given("a session whose reply has a visualization that probes the app", async ({ page, project, $testInfo }) => {
  const run = runDir();
  const configDir = join(run, `claude-config-w${$testInfo.workerIndex}`);
  transcript = writeReplyTranscript({ sessionId: randomUUID(), cwd: project.path, configDir, run, prompt: "Show the probe", reply: `Here it is.\n\n\`\`\`visualize\n${PROBE}\n\`\`\`\n\nDone.` });
  own = await startDaemon(run, 1000 + $testInfo.workerIndex, { port: await freePort(ownerPorts(), ""), env: { CLAUDE_CONFIG_DIR: configDir } });
  await openApp(page, own);
  await openProject(page, project.path);
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("session-item").filter({ hasText: "Show the probe" }).first().click({ timeout: 60_000 });
  await expect(page.getByTestId("assistant-text").filter({ hasText: "Here it is" })).toBeVisible({ timeout: 30_000 });
});

When("I send the prompt {string} and wait for the turn to end", async ({ page }, text: string) => {
  await sendPrompt(page, text);
  await waitTurnEnd(page);
});

Then("the visualization frame is shown", async ({ page }) => {
  await expect(frame(page)).toBeVisible({ timeout: 30_000 });
  await expect(frame(page)).toHaveAttribute("sandbox", "allow-scripts");
});

Then("the visualization frame is shown with a fitting height and a chart", async ({ page }) => {
  await expect(frame(page)).toBeVisible({ timeout: 30_000 });
  await expect(inner(page).locator("svg, canvas").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await frame(page).boundingBox())?.height ?? 0, { timeout: 15_000 }).toBeGreaterThan(48);
  expect((await frame(page).boundingBox())!.height).toBeLessThanOrEqual(800);
});

// The frame document's own painted background (not only the variable): a transparent one shows the embedder's canvas, which stays light in a dark app.
const bgOf = (page: Page) => inner(page).locator("html").evaluate((e) => getComputedStyle(e).backgroundColor);
Then("I note the background colour of the visualization frame", async ({ page }) => {
  bg = await bgOf(page);
  expect(bg).not.toBe("");
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
});
Then("the background colour of the visualization frame changed", async ({ page }) => {
  await expect.poll(() => bgOf(page), { timeout: 10_000 }).not.toBe(bg);
});

Then("the visualization reports {string}", async ({ page }, text: string) => {
  await expect(frame(page)).toBeVisible({ timeout: 30_000 });
  await expect(inner(page).locator("#o")).toHaveText(text, { timeout: 15_000 });
});

Then("the visualization frame fits the viewport width", async ({ page }) => {
  await expect(frame(page)).toBeVisible();
  const b = (await frame(page).boundingBox())!;
  const w = await page.evaluate(() => window.innerWidth);
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(w + 0.5);
});

When("I open Settings › Chat", async ({ page }) => {
  await openSettings(page);
  await page.getByTestId("settings-group-chat").click();
  await expect(page.getByTestId("settings-chat")).toBeVisible();
});

const setSwitch = async (page: Page, want: "true" | "false") => {
  const sw = page.getByTestId("settings-chat-visualize");
  if ((await sw.getAttribute("aria-checked")) !== want) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", want);
};
When("I turn the inline visualizations switch off", async ({ page }) => setSwitch(page, "false"));
When("I turn the inline visualizations switch on", async ({ page }) => setSwitch(page, "true"));

Then("the reply shows the visualization as a code block without a frame", async ({ page }) => {
  await expect(page.getByTestId("visualize-frame")).toHaveCount(0);
  await expect(page.getByTestId("assistant-text").filter({ hasText: "Here it is" }).locator("pre").first()).toContainText("parent:");
});

After(async () => {
  await own?.stop();
  own = undefined;
  if (transcript) rmSync(dirname(transcript), { recursive: true, force: true });
  transcript = undefined;
});

// Question card visuals: Haiku copies these files verbatim into AskUserQuestion, so the HTML needs no quoting in the prompt.
const Q_FILES: Record<string, string> = {
  "q.md": ["Which chart, and which threshold?", "", "```visualize", `<p style="margin:0 0 4px">Drag to pick a threshold</p><input type="range" id="r" min="0" max="100" value="50" style="width:100%" oninput="parent.postMessage({v:1,type:'answer',text:'threshold '+this.value},'*')">`, "```"].join("\n"),
  "a.md": ["```mermaid", "flowchart LR", "  A[Input] --> B[Model] --> C[Answer]", "```"].join("\n"),
  "b.md": ["```visualize", '<svg viewBox="0 0 240 120" width="100%"><rect x="20" y="70" width="40" height="40" fill="var(--primary)"/><rect x="90" y="40" width="40" height="70" fill="#3b82f6"/><rect x="160" y="10" width="40" height="100" fill="#f59e0b"/></svg>', "```"].join("\n"),
};

Given("the project has the question visual files", async ({ project }) => {
  for (const [name, text] of Object.entries(Q_FILES)) writeFileSync(join(project.path, name), text + "\n");
});

const card = (page: Page) => page.getByTestId("question-panel");
const previews = (page: Page) => card(page).getByTestId("question-preview");

Then("the question shows its visualization and {int} option previews", async ({ page }, n: number) => {
  await expect(card(page)).toBeVisible({ timeout: TURN_MS });
  await expect(card(page).getByTestId("question-text").getByTestId("visualize-frame")).toBeVisible({ timeout: 30_000 });
  await expect(previews(page)).toHaveCount(n);
  await expect(previews(page).nth(1).getByTestId("visualize-frame")).toBeVisible({ timeout: 30_000 });
});

Then("the option previews are {word}", async ({ page }, layout: string) => {
  await previews(page).first().scrollIntoViewIfNeeded();
  const [a, b] = [(await previews(page).nth(0).boundingBox())!, (await previews(page).nth(1).boundingBox())!];
  if (layout === "side-by-side") expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  else expect(b.y).toBeGreaterThan(a.y + a.height - 2);
});

When("I drag the slider in the question visualization to {int}", async ({ page }, v: number) => {
  await page.frameLocator('[data-testid="question-text"] [data-testid="visualize-frame"]').locator("#r").fill(String(v));
});

Then("the own answer field holds {string}", async ({ page }, text: string) => {
  await expect(card(page).getByPlaceholder("Type your answer...")).toHaveValue(text);
});

When("I choose the option {string} from its preview", async ({ page }, label: string) => {
  await previews(page).getByRole("button", { name: label }).click();
  await expect(previews(page).getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
});
