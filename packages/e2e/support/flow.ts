// Multi-step flows used by more than one step (a step never calls another step's text).
import { basename } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { Daemon } from "./daemon.ts";
import { idleSend, promptBox, sendButton, TURN_MS, waitConnected } from "./ui.ts";

export const REPLY_PROMPT = "Reply with exactly: OK";

/** Opens the paired app. The first-run tour is marked as offered, as it is for any returning user. */
export async function openApp(page: Page, daemon: Daemon): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (!localStorage.getItem("claude-ui.guide")) localStorage.setItem("claude-ui.guide", JSON.stringify({ v: 1, origin: "existing", basics: "offered", session: "offered" }));
    } catch {}
  });
  await page.goto(`${daemon.origin}/#token=${daemon.token}`);
  await waitConnected(page);
}

/** Open project dialog: the folder path with a trailing separator opens that folder itself, not its parent. */
export async function openProject(page: Page, path: string): Promise<void> {
  const dialog = page.getByTestId("open-project-dialog");
  if (!(await dialog.isVisible())) {
    // The sidebar's "Open project" button; on a phone the sidebar is a drawer to open first.
    if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
    await page.getByTestId("open-project").click();
  }
  await expect(dialog).toBeVisible();
  const sep = path.includes("\\") ? "\\" : "/";
  const input = page.getByTestId("folder-input");
  // The dialog starts inside its single root once the folder list arrives and overwrites the input then: type after that.
  await expect(input).not.toHaveValue("");
  await input.fill(path.endsWith(sep) ? path : path + sep);
  await expect(page.getByTestId("open-folder")).toHaveText(`Open ${basename(path)}`);
  await page.getByTestId("open-folder").click();
  await expect(dialog).toBeHidden();
}

/** The new-session tab (shown after Open project) with Haiku chosen; asserts the session starts in the Default permission mode. */
export async function prepareHaikuSession(page: Page, projectName: string): Promise<void> {
  // The app scans every listed project transcript after "Open project" and only then shows the tab: seconds on a loaded machine.
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  // The tab keeps the project it had chosen before until the project list has refreshed; then ours is in the chooser: pick it, as a user would.
  const chip = page.getByTestId("project-chip");
  await expect(async () => {
    if ((await chip.textContent())?.includes(projectName)) return;
    try {
      await chip.click();
      await page.getByRole("option", { name: projectName }).click({ timeout: 2_000 });
      await expect(chip).toContainText(projectName, { timeout: 2_000 });
    } catch (e) {
      await page.keyboard.press("Escape");
      throw e;
    }
  }).toPass({ timeout: 60_000 });
  // A phone keeps mode, model and effort in a popup behind one button.
  const settings = page.getByTestId("session-settings");
  const phone = await settings.isVisible();
  if (phone) await settings.click();
  const model = page.getByTestId("session-model");
  await model.click();
  await page.getByRole("option", { name: "Haiku" }).click();
  await expect(model).toContainText("Haiku");
  // The project's .claude/settings.json asks for "default" (Ask before edits); the owner's own "auto" must not leak in.
  await expect(page.getByTestId("mode-select")).toHaveAttribute("aria-label", /^Ask before edits/);
  if (phone) await page.keyboard.press("Escape");
}

export async function sendPrompt(page: Page, text: string): Promise<void> {
  const box = promptBox(page);
  await box.fill(text);
  await expect(sendButton(page)).toBeEnabled();
  await sendButton(page).click();
}

/** The send button is idle before the session exists too: wait for the sent prompt first, then for idle. */
export async function waitTurnEnd(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])').first()).toBeVisible({ timeout: TURN_MS });
  await expect(idleSend(page)).toBeVisible({ timeout: TURN_MS });
}
