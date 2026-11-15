// OpenCode parity features (GH-658): rewind, slash commands, hidden Claude-only controls, orchestration attach, aside.
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { runDir } from "../support/paths.ts";
import { After, Given, When } from "./fixtures.ts";

/** A phone keeps mode, model and effort behind one button. */
const settingsOpen = async (page: Page) => {
  const s = page.getByTestId("session-settings");
  if (await s.isVisible()) await s.click();
};

When("I pick the OpenCode model {string} in the model chooser", async ({ page }, name: string) => {
  // The chooser may close on a toolbar re-render (agents or models arriving): reopen until the option is clicked.
  const option = page.getByRole("option", { name: new RegExp(`^${name}`) });
  const popup = page.getByTestId("session-settings-popup");
  await expect(async () => {
    if (!(await option.isVisible())) {
      if (!(await popup.isVisible())) await settingsOpen(page);
      await page.getByTestId("session-model").filter({ visible: true }).first().click({ timeout: 3000 });
    }
    await option.click({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // The next step opens the phone popup itself; a popup still closing would detach its controls.
  await expect(popup).toBeHidden();
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
