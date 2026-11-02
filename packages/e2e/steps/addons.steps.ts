import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { REPO_ROOT } from "../support/daemon.ts";
import { sendPrompt } from "../support/flow.ts";
import { pickPane, promptBox } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

// GH-516 addons. The daemon of a run persists across scenarios (one worker): every Given is idempotent.
export const EXAMPLE = join(REPO_ROOT, "examples", "addons", "example");
const dialog = (page: Page): Locator => page.getByTestId("addons-dialog");
export const addonRow = (page: Page, name: string): Locator => page.locator(`[data-testid="addons-row"][data-name="${name}"]`);

/** `/addons` in the prompt box opens the dialog (a dialog command is never sent). */
export async function openAddons(page: Page): Promise<void> {
  if (await dialog(page).isVisible()) return void (await expect(dialog(page).getByText("Loading addons…")).toHaveCount(0));
  await promptBox(page).fill("/addons");
  await promptBox(page).press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText("Loading addons…")).toHaveCount(0);
}
const closeAddons = async (page: Page) => {
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
};
async function installExample(page: Page): Promise<void> {
  await page.getByTestId("addons-source-local").click();
  await page.getByTestId("addons-path").fill(EXAMPLE);
  await page.getByTestId("addons-install").click();
  await expect(page.getByTestId("addons-approve-card")).toBeVisible();
}
const approve = async (page: Page) => page.getByTestId("addons-approve").first().click();

Given("the example addon is not installed", async ({ page }) => {
  await openAddons(page);
  if (await addonRow(page, "example").count()) {
    await addonRow(page, "example").getByTestId("addons-uninstall").click();
    await page.getByTestId("addons-remove").click();
    await expect(addonRow(page, "example")).toHaveCount(0);
  }
  await closeAddons(page);
});

/** Installs, approves and enables the example addon when it is not yet enabled; the dialog is closed after. */
Given("the example addon is installed and enabled", async ({ page }) => {
  await openAddons(page);
  const row = addonRow(page, "example");
  if (!(await row.count())) {
    await installExample(page);
    await approve(page);
  } else if ((await row.getByTestId("addons-state").innerText()) === "Needs approval") await approve(page);
  else if ((await row.getByTestId("addons-state").innerText()) !== "Enabled") await row.getByTestId("addons-enabled").click();
  await expect(row.getByTestId("addons-state")).toHaveText("Enabled");
  await closeAddons(page);
});

When("I open the Addons dialog", async ({ page }) => openAddons(page));

When("I install the addon from the local folder of the example addon", async ({ page }) => installExample(page));

Then("the approval card lists the capabilities of the example addon", async ({ page }) => {
  await expect(page.getByTestId("addons-approve-card").getByTestId("addons-capability")).toHaveCount(10);
});

When("I approve the addon", async ({ page }) => approve(page));

Then("the addon {string} is enabled", async ({ page }, name: string) => {
  const row = addonRow(page, name);
  await expect(row.getByTestId("addons-state")).toHaveText("Enabled");
  await expect(row.getByTestId("addons-enabled")).toHaveAttribute("aria-checked", "true");
});

/** The stylesheet link of an addon sets `--<name>-css: 1` on :root (theme.css of the example). */
const cssFlag = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}-css`).trim(), name);

async function setAddonEnabled(page: Page, name: string, enabled: boolean): Promise<void> {
  await openAddons(page);
  const sw = addonRow(page, name).getByTestId("addons-enabled");
  if ((await sw.getAttribute("aria-checked")) !== String(enabled)) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", String(enabled));
  await closeAddons(page);
}
When("I disable the addon {string}", async ({ page }, name: string) => setAddonEnabled(page, name, false));
When("I enable the addon {string}", async ({ page }, name: string) => setAddonEnabled(page, name, true));

Then("the addon stylesheet of {string} is applied", async ({ page }, name: string) => {
  await expect.poll(() => cssFlag(page, name)).toBe("1");
});
Then("the addon stylesheet of {string} is not applied", async ({ page }, name: string) => {
  await expect.poll(() => cssFlag(page, name)).toBe("");
});

const PANE_ID: Record<string, string> = { Stats: "addon:example:stats" };
const paneFrame = (page: Page) => page.frameLocator('[data-testid="addon-frame-example-pane"]');

When("I open the {string} addon pane in the side panel", async ({ page }, title: string) => {
  await pickPane(page, PANE_ID[title]!, page.getByTestId("side-panel"));
  await expect(page.getByTestId("addon-frame-example-pane")).toBeVisible();
});

Then("the addon pane shows the part counts of the session", async ({ page }) => {
  await expect(paneFrame(page).getByTestId("example-parts")).toHaveText(/\d+ parts/);
});

When("I click {string} in the addon pane", async ({ page }, label: string) => {
  await paneFrame(page).getByRole("button", { name: label, exact: true }).click();
});

Then("the status bar shows {string} status {string}", async ({ page }, addon: string, text: string) => {
  await expect(page.getByTestId(`addon-status-${addon}`)).toHaveText(text);
});

Then("the pane shows a refused error", async ({ page }) => {
  await expect(paneFrame(page).getByTestId("example-refused")).toContainText("Refused");
});

Then("the log of {string} lists {string}", async ({ page }, name: string, type: string) => {
  await expect(addonRow(page, name).getByTestId("addons-log")).toContainText(type);
});

Then("the pane switcher does not list {string}", async ({ page }, title: string) => {
  await expect(page.getByTestId("pane-session").first()).toBeAttached();
  await page.locator('[data-testid="pane-overflow"]:visible').first().click().catch(() => {});
  await expect(page.locator(`[data-testid="pane-${PANE_ID[title]}"]:visible`)).toHaveCount(0);
});

let userMessages = 0;
const userMessage = (page: Page) => page.locator('[data-testid="user-message"]:not([data-pending])');
When("I count the user messages", async ({ page }) => void (userMessages = await userMessage(page).count()));
Then("no new user message is shown", async ({ page }) => {
  await page.waitForTimeout(500);
  await expect(userMessage(page)).toHaveCount(userMessages);
});

const bandFrame = (page: Page) => page.getByTestId("addon-frame-example-band");
Then("the addon band of {string} is above the prompt box", async ({ page }, _name: string) => {
  const band = bandFrame(page);
  await expect(band).toBeVisible();
  const [b, p] = [await band.boundingBox(), await promptBox(page).boundingBox()];
  expect(b!.y + b!.height).toBeLessThanOrEqual(p!.y);
});
Then("the band shows the turn count", async ({ page }) => {
  await expect(page.frameLocator('[data-testid="addon-frame-example-band"]').getByTestId("example-band")).toHaveText(/\d+ turns?/);
});

Then("the command picker lists {string} with its description", async ({ page }, name: string) => {
  const row = page.getByRole("option").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Insert a sample prompt");
});
When("I run {string}", async ({ page }, text: string) => {
  await promptBox(page).fill(text);
  await promptBox(page).press("Enter");
});
Then("the prompt box contains {string}", async ({ page }, text: string) => {
  // the command inserts its text plus one trailing space for typing on
  await expect.poll(() => promptBox(page).inputValue()).toBe(text + " ");
});

When("I send a prompt containing an {string} code fence with {string}", async ({ page }, lang: string, source: string) => {
  await sendPrompt(page, `Reply with OK.\n\`\`\`${lang}\n${source}\n\`\`\``);
});
const lastUser = (page: Page) => page.getByTestId("user-message").last();
Then("the user message shows the addon block of {string}", async ({ page }, name: string) => {
  const block = lastUser(page).locator(`[data-testid="addon-block"][data-addon="${name}"]`);
  await expect(block).toBeVisible({ timeout: 30_000 });
  const card = block.frameLocator(`[data-testid="addon-frame-${name}-render"]`).locator("body");
  await expect(card).toContainText("hello addon");
  await expect(card).toContainText("2 words");
});
When("I click show raw", async ({ page }) => {
  await lastUser(page).getByTestId("addon-show-raw").click();
});
Then("the code fence source {string} is shown", async ({ page }, source: string) => {
  await expect(lastUser(page).locator("pre")).toContainText(source);
  await expect(lastUser(page).locator("iframe")).toHaveCount(0);
});
Then("the addon {string} is not listed", async ({ page }, name: string) => {
  await openAddons(page);
  await expect(addonRow(page, name)).toHaveCount(0);
});

// GH-516 acceptance 2: overflow menu, git URL redaction, uninstall CSS, session switch.
When("I open the {string} addon pane from the more panes menu", async ({ page }, title: string) => {
  const side = page.getByTestId("side-panel");
  const id = PANE_ID[title]!;
  await expect(side.locator(`[role="tab"][data-testid="pane-${id}"]:visible`)).toHaveCount(0);
  await side.getByTestId("pane-overflow").click();
  await page.getByRole("menuitem").and(page.getByTestId(`pane-${id}`)).click();
  await expect(page.getByTestId("addon-frame-example-pane")).toBeVisible();
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "pipe" });
let bare = "";
When("I install the example addon from a git URL with the password {string}", async ({ page }, password: string) => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "e2e-addon-git-")));
  cpSync(EXAMPLE, join(tmp, "work"), { recursive: true });
  git(join(tmp, "work"), "init", "-q", "-b", "main");
  git(join(tmp, "work"), "add", "-A");
  git(join(tmp, "work"), "commit", "-q", "-m", "example");
  bare = join(tmp, "origin.git");
  git(tmp, "clone", "-q", "--bare", join(tmp, "work"), bare);
  await openAddons(page);
  await page.getByTestId("addons-source-git").click();
  await page.getByRole("textbox", { name: "Repository URL" }).fill(`file://alice:${password}@localhost${bare}`);
  await page.getByTestId("addons-install").click();
  await expect(page.getByTestId("addons-approve-card")).toBeVisible();
});
Then("the Addons dialog shows the git source without {string}", async ({ page }, password: string) => {
  const d = dialog(page);
  await expect(d).toContainText(`git: file://localhost${bare}`);
  await expect(d).not.toContainText(password);
  await expect(d).not.toContainText("alice");
  expect(await d.innerHTML()).not.toContain(password);
});
When("I uninstall the addon {string}", async ({ page }, name: string) => {
  await openAddons(page);
  await addonRow(page, name).getByTestId("addons-uninstall").click();
  await page.getByTestId("addons-remove").click();
  await expect(addonRow(page, name)).toHaveCount(0);
  await closeAddons(page);
});

let paneParts = "";
const partsText = (page: Page) => paneFrame(page).getByTestId("example-parts").innerText();
const partCount = (t: string) => Number(/^(\d+) parts/.exec(t)?.[1]);
When("I note the part counts of the addon pane", async ({ page }) => {
  await expect(paneFrame(page).getByTestId("example-parts")).toHaveText(/\d+ parts/);
  paneParts = await partsText(page);
});
When("I send the prompt {string} and wait for the reply", async ({ page }, text: string) => {
  const box = page.getByRole("combobox", { name: /^Prompt$/ }).last();
  await box.fill(text);
  await page.getByTestId("send").last().click();
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])').last()).toContainText("TWO", { timeout: 60_000 });
  await expect(page.locator('[data-testid="send"][data-state="idle"]').last()).toBeVisible({ timeout: 120_000 });
});
Then("the side panel shows exactly one addon pane frame", async ({ page }) => {
  await expect(page.getByTestId("addon-frame-example-pane")).toHaveCount(1);
});
Then("the addon pane shows more parts than noted", async ({ page }) => {
  await expect.poll(async () => partCount(await partsText(page)), { timeout: 30_000 }).toBeGreaterThan(partCount(paneParts));
});
Then("the addon pane shows the noted part counts", async ({ page }) => {
  await expect.poll(() => partsText(page), { timeout: 30_000 }).toBe(paneParts);
});

Then("the band text is fully visible", async ({ page }) => {
  const frame = page.frameLocator('[data-testid="addon-frame-example-band"]');
  await expect(frame.getByTestId("example-band")).toHaveText(/\d+ turns?/);
  const [box, text] = await Promise.all([bandFrame(page).boundingBox(), frame.getByTestId("example-band").boundingBox()]);
  const m = await frame.locator("html").evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, sw: e.scrollWidth, cw: e.clientWidth }));
  expect(m.sh, JSON.stringify(m)).toBeLessThanOrEqual(m.ch);
  expect(m.sw, JSON.stringify(m)).toBeLessThanOrEqual(m.cw);
  expect(text!.y + text!.height).toBeLessThanOrEqual(box!.y + box!.height + 0.5);
  expect(text!.x + text!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
});
