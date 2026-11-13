// A loaded session whose transcript file is deleted outside the app (docs/spec.md "Sessions"): the next list drops it.
import { rmSync } from "node:fs";
import { expect } from "@playwright/test";
import { transcriptOf } from "../support/transcript.ts";
import { When, Then } from "./fixtures.ts";

const sessionId = (page: import("@playwright/test").Page) => new URL(page.url()).hash.replace(/^#/, "").split("/")[0]!;

When("I delete the transcript file of the open session", async ({ page, memo }) => {
  const id = sessionId(page);
  const file = transcriptOf(id);
  expect(file, "the session has a transcript").toBeTruthy();
  memo.owner = id;
  rmSync(file!);
});

Then("the sidebar has no row for the deleted session", async ({ page, memo }) => {
  const id = memo.owner!;
  await expect(page.locator(`[data-testid="session-item"][data-session-id="${id}"]`)).toHaveCount(0, { timeout: 30_000 });
});

Then("the sidebar has no row titled {string}", async ({ page }, title: string) => {
  await expect(page.locator('[data-testid="session-item"]').filter({ hasText: title })).toHaveCount(0);
});
