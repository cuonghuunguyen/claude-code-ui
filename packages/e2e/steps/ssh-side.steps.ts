// SSH Side acceptance (GH-546): see features/ssh-side.feature. POSIX with docker and the ssh tools only.
import { expect } from "@playwright/test";
import { REMOTE_PROJECT } from "../support/ssh-host.ts";
import { openApp, openProject } from "../support/flow.ts";
import { openSettings, pickPane } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";
import { endsWithPath } from "../support/css.ts";

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

When("I open the app and Settings › Sides", async ({ page, daemon }) => {
  await openApp(page, daemon);
  await openSettings(page);
  await page.getByTestId("settings-group-sides").click();
  await expect(page.getByTestId("settings-sides")).toBeVisible();
});
