import { REPLY_PROMPT, openApp, openProject, prepareHaikuSession, sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { expect } from "@playwright/test";
import { TURN_MS, waitConnected } from "../support/ui.ts";
import { Given, When } from "./fixtures.ts";

Given("the viewport is {int}x{int}", async ({ page }, width: number, height: number) => {
  await page.setViewportSize({ width, height });
});

Given("the app is open", async ({ page, daemon }) => {
  await openApp(page, daemon);
});

Given("I open the scratch project", async ({ page, project }) => {
  await openProject(page, project.path);
});

Given("I start a new Haiku session", async ({ page, project }) => {
  await prepareHaikuSession(page, project.name);
});

Given("a Haiku session with one finished reply", async ({ page, daemon, project }) => {
  await openApp(page, daemon);
  await openProject(page, project.path);
  await prepareHaikuSession(page, project.name);
  await sendPrompt(page, REPLY_PROMPT);
  await expect(page.getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: TURN_MS });
  await waitTurnEnd(page);
});

When("I reload the page", async ({ page }) => {
  await page.reload();
  await waitConnected(page);
});
