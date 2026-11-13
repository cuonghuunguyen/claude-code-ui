// SSH Side acceptance (GH-546): see features/ssh-side.feature. POSIX with docker and the ssh tools only.
import { expect } from "@playwright/test";
import { REMOTE_PROJECT } from "../support/ssh-host.ts";
import { openApp, openProject, sendPrompt } from "../support/flow.ts";
import { openSettings, pickPane } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";
import { endsWithPath } from "../support/css.ts";

const settingsStart = (page: import("@playwright/test").Page, alias: string) => page.getByTestId(`settings-side-start-ssh:${alias}`);

Given("a throwaway SSH host", async ({ sshHost, $test }) => {
  $test.skip(process.platform === "win32", "the throwaway sshd needs a POSIX host with docker and the ssh tools");
  await sshHost.get();
});

When("I choose the SSH host {string} in Open project", async ({ page, daemon }, alias: string) => {
  await openApp(page, daemon);
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("open-project").click();
  await expect(page.getByTestId("open-project-dialog")).toBeVisible();
  // The hosts come from the run's ssh config: the SSH kind is there once the hub listed them.
  await page.getByTestId("side-kind").filter({ hasText: "SSH" }).click({ timeout: 30_000 });
  await page.getByTestId("container-row").filter({ hasText: alias }).click();
});

When("I install the SSH host and record the phases", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __phases: string[] };
    w.__phases = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="side-progress"]')?.textContent?.trim();
      if (t && w.__phases.at(-1) !== t) w.__phases.push(t);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByTestId("side-install").click({ timeout: 120_000 });
  // The Browser (folder input) shows once the Side is ready.
  await expect(page.getByTestId("folder-input")).toBeVisible({ timeout: 240_000 });
});

Then("the phases include preparing and unpacking in the host", async ({ page }) => {
  const phases = await page.evaluate(() => (window as unknown as { __phases: string[] }).__phases);
  // "Copying into the host" can pass between two DOM updates on a fast pipe: not required.
  for (const p of [/Preparing/, /Unpacking claude-ui in the host/]) expect(phases.some((x) => p.test(x)), `phases seen: ${phases.join(" | ")}`).toBe(true);
});

When("I open the remote project folder", async ({ page }) => {
  // An installed Side starts by itself once chosen; a fresh container (a new worker) shows Install first.
  // Enabled only: a Side that is starting shows the same test id on a disabled button.
  const install = page.locator('[data-testid="side-install"]:not([disabled])');
  await expect(install.or(page.getByTestId("folder-input"))).toBeVisible({ timeout: 120_000 });
  if (await install.isVisible()) await install.click();
  await expect(page.getByTestId("folder-input")).toBeVisible({ timeout: 240_000 });
  await openProject(page, REMOTE_PROJECT);
});

Then("the sidebar shows the project under the side {string}", async ({ page }, label: string) => {
  await expect(page.locator(`[data-testid="side-badge"][title="${label}"]`).first()).toBeVisible({ timeout: 60_000 });
});

Then("the Files pane lists {string}", async ({ page }, name: string) => {
  // pickPane does not wait: the side panel renders a moment after the project opens.
  await expect(page.locator('[role="tab"][data-testid="pane-files"]:visible, [data-testid="pane-overflow"]:visible').first()).toBeVisible({ timeout: 30_000 });
  await pickPane(page, "files");
  await expect(page.locator(`[data-testid="tree-entry"]${endsWithPath("data-path", name)}`).first()).toBeVisible({ timeout: 60_000 });
});

Then("the Changes pane lists {string}", async ({ page }, name: string) => {
  await pickPane(page, "changes");
  // hello.txt is an untracked file; pick Uncommitted explicitly so the step holds under any saved default.
  await page.getByTestId("diff-mode").click();
  await page.getByRole("option", { name: "Uncommitted" }).click();
  await expect(page.getByTestId("changed-file").filter({ hasText: name }).first()).toBeVisible({ timeout: 60_000 });
});

When("I send the prompt {string} in the remote project", async ({ page }, text: string) => {
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await sendPrompt(page, text);
});

Then("the session says Claude is not logged in", async ({ page }) => {
  await expect(page.getByText(/not logged in|\/login|log in|authenticat/i).first()).toBeVisible({ timeout: 120_000 });
});

When("I open the app and Settings › Sides", async ({ page, daemon }) => {
  await openApp(page, daemon);
  await openSettings(page);
  await page.getByTestId("settings-group-sides").click();
  await expect(page.getByTestId("settings-sides")).toBeVisible();
});

Then("the Settings row of the SSH host {string} says Start with Claude UI is {string}", async ({ page }, alias: string, state: string) => {
  await expect(settingsStart(page, alias)).toHaveAttribute("aria-checked", state === "on" ? "true" : "false", { timeout: 30_000 });
});

When("I turn on Start with Claude UI for the SSH host {string}", async ({ page }, alias: string) => {
  await settingsStart(page, alias).click();
});

Then("the side panel says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("side-status")).toContainText(text, { timeout: 90_000 });
});

// GH-515 on an SSH host: the custom name and icon show in Settings, the Open project target and the project badge.
When("I rename the SSH host {string} to {string} with the emoji {string}", async ({ page }, alias: string, name: string, emoji: string) => {
  await page.getByTestId(`settings-side-edit-ssh:${alias}`).click();
  await page.getByTestId("label-name").fill(name);
  await page.getByTestId("label-icon-emoji").click();
  await page.getByTestId("label-emoji").fill(emoji);
  await page.getByTestId("label-save").click();
  await expect(page.getByTestId("label-dialog")).toBeHidden();
});

Then("the Settings row of the SSH host {string} is named {string}", async ({ page }, alias: string, name: string) => {
  await expect(page.getByTestId(`settings-side-ssh:${alias}`).getByTestId("settings-side-name")).toHaveText(name);
});

When("I list the SSH hosts in Open project", async ({ page }) => {
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("open-project").click();
  await expect(page.getByTestId("open-project-dialog")).toBeVisible();
  await page.getByTestId("side-kind").filter({ hasText: "SSH" }).click({ timeout: 30_000 });
});

When("I pick the SSH host named {string}", async ({ page }, name: string) => {
  await page.getByTestId("container-row").filter({ hasText: name }).click();
});

Then("the Open project target shows {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("side-target")).toContainText(name, { timeout: 120_000 });
});

Then("the project badge shows {string}", async ({ page }, name: string) => {
  await expect(page.getByTestId("side-badge").filter({ hasText: name }).first()).toBeVisible({ timeout: 60_000 });
});

// GH-554: the Open project rows show the custom name and icon, the raw name beside, and the filter matches both.
Then("the Open project row {string} shows the emoji {string} and the raw name {string}", async ({ page }, name: string, emoji: string, raw: string) => {
  const row = page.getByTestId("container-row").filter({ hasText: name });
  await expect(row.getByTestId("label-glyph-emoji")).toHaveText(emoji);
  await expect(row.getByTestId("container-raw-name")).toHaveText(raw);
});

When("I filter the Open project list by {string}", async ({ page }, text: string) => {
  await page.getByTestId("container-filter").fill(text);
});

Then("the Open project list shows only {string}", async ({ page }, name: string) => {
  const rows = page.getByTestId("container-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(name);
});

// The dialog opens on the last chosen side; clearing it shows the host list.
When("Open project forgets the last chosen side", async ({ page }) => {
  await page.evaluate(() => {
    for (const k of ["claude-ui.side", "claude-ui.side.ssh"]) localStorage.removeItem(k);
  });
});
