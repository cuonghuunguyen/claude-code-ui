import { type Page } from "@playwright/test";
import { makeRepoWithTwoCommits } from "../support/git-fixture.ts";
import { Given, When } from "./fixtures.ts";
const sessionTabs = (page: Page) =>
  page.locator('[data-testid="tab"]:not([data-tab-id^="files:"]):not([data-tab-id^="graph:"]):not([data-tab-id^="plan:"]):not([data-tab-id^="terminal:"]):not([data-tab-id=""])').filter({ has: page.locator('[role="tab"]') });

Given("the scratch project is a git repository with two commits", async ({ project }) => {
  makeRepoWithTwoCommits(project.path);
});

When("I click the first session tab", async ({ page }) => {
  await sessionTabs(page).first().locator('[role="tab"]').click();
});
