// SSH Side acceptance (GH-546): see features/ssh-side.feature. POSIX with docker and the ssh tools only.
import { expect } from "@playwright/test";
import { REMOTE_PROJECT } from "../support/ssh-host.ts";
import { openApp, openProject, sendPrompt } from "../support/flow.ts";
import { openSettings, pickPane } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

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

Then("the phases include packing, copying into the host and starting", async ({ page }) => {
  const phases = await page.evaluate(() => (window as unknown as { __phases: string[] }).__phases);
  for (const p of [/Packing/, /Copying into the host/, /Starting/]) expect(phases.some((x) => p.test(x)), `phases seen: ${phases.join(" | ")}`).toBe(true);
});

When("I open the remote project folder", async ({ page }) => {
  // An installed Side starts by itself once chosen; a fresh container (a new worker) shows Install first.
  const install = page.getByTestId("side-install");
  await expect(install.or(page.getByTestId("folder-input"))).toBeVisible({ timeout: 120_000 });
  if (await install.isVisible()) await install.click();
  await expect(page.getByTestId("folder-input")).toBeVisible({ timeout: 240_000 });
  await openProject(page, REMOTE_PROJECT);
});

Then("the sidebar shows the project under the side {string}", async ({ page }, label: string) => {
  await expect(page.locator(`[data-testid="side-badge"][title="${label}"]`).first()).toBeVisible({ timeout: 60_000 });
});

Then("the Files pane lists {string}", async ({ page }, name: string) => {
  await pickPane(page, "files");
  await expect(page.locator(`[data-testid="tree-entry"][data-path$="/${name}"]`).first()).toBeVisible({ timeout: 60_000 });
});

Then("the Changes pane lists {string}", async ({ page }, name: string) => {
  await pickPane(page, "changes");
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
