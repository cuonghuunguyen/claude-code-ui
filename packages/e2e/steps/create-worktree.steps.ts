
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { git, makeRepoWithOrigin } from "../support/git-fixture.ts";
import { runDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";
import { cssStr } from "../support/css.ts";

const modal = (page: Page) => page.getByTestId("create-worktree");
const row = (page: Page, path: string) => page.locator(`[data-testid="group-toggle"][title="${cssStr(path)}"]`).locator("xpath=ancestor::h3");
const worktreeDir = (project: string, folder: string) => join(project, ".claude", "worktrees", folder);

Given("the scratch project is a git repository with an origin", async ({ project }) => {
  makeRepoWithOrigin(project.path, join(runDir(), "origins", `${project.name}.git`));
});

When("I click the new worktree button of the scratch project", async ({ page, project }) => {
  const r = row(page, project.path);
  await r.hover();
  await r.getByTestId("project-new-worktree").click({ timeout: 60_000 });
});

When("I choose {string} in the menu of the scratch project", async ({ page, project }, entry: string) => {
  // The phone's sidebar is a drawer: open it, then wait for the project row (the project list refreshes after Open project).
  // Opening a project ends in a new-session tab that closes the drawer: wait for it first.
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("open-drawer")).toBeVisible();
  await page.getByTestId("open-drawer").click();
  const r = row(page, project.path);
  // Earlier scenarios' projects stay in the shared daemon and sort above this empty one: scroll to it.
  await r.getByTestId("project-menu").scrollIntoViewIfNeeded({ timeout: 60_000 });
  await expect(r.getByTestId("project-menu")).toBeInViewport({ timeout: 60_000 });
  await r.getByTestId("project-menu").click();
  await page.getByTestId(`project-menu-${entry}`).click();
});

Then("the menu of the scratch project has {string} and not {string}", async ({ page, project }, has: string, hasNot: string) => {
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  const r = row(page, project.path);
  const phone = await page.getByTestId("open-drawer").isVisible();
  const prefix = phone ? "project-menu-" : "group-menu-"; // the context menu on desktop has its own ids
  if (phone) {
    await page.getByTestId("open-drawer").click();
    await r.getByTestId("project-menu").scrollIntoViewIfNeeded({ timeout: 60_000 });
    await expect(r.getByTestId("project-menu")).toBeInViewport({ timeout: 60_000 });
    await r.getByTestId("project-menu").click();
  } else await r.getByTestId("group-toggle").click({ button: "right", timeout: 60_000 }); // desktop: the kebab is phone-only, the menu is the context menu
  await expect(page.getByTestId(`${prefix}${has}`)).toBeVisible();
  await expect(page.getByTestId(`${prefix}${hasNot}`)).toHaveCount(0);
});

Then("the Create worktree modal is open", async ({ page }) => {
  await expect(modal(page)).toBeVisible();
});

Then("no Create worktree modal is open", async ({ page }) => {
  await expect(modal(page)).toBeHidden();
});

When("I open the {string} tab of the modal", async ({ page }, tab: string) => {
  await page.getByTestId(`create-worktree-tab-${tab}`).click();
});

When("I type the worktree name {string}", async ({ page }, name: string) => {
  await page.getByTestId("create-worktree-name").fill(name);
});

Then("the modal shows branch {string} in folder {string}", async ({ page }, branch: string, folder: string) => {
  await expect(page.getByTestId("create-worktree-branch")).toHaveText(branch);
  await expect(page.getByTestId("create-worktree-folder")).toHaveText(folder);
});

When("I confirm the modal", async ({ page }) => {
  await page.getByTestId("create-worktree-confirm").click();
});

Then("the modal closes", async ({ page }) => {
  await expect(modal(page)).toBeHidden({ timeout: 60_000 });
});

Then("the new-session tab runs in the worktree {string}", async ({ page }, branch: string) => {
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("worktree-chip")).toContainText(branch, { timeout: 60_000 });
});

Then("the worktree folder {string} is on branch {string}", async ({ project }, folder: string, branch: string) => {
  const dir = worktreeDir(project.path, folder);
  expect(existsSync(dir), `${dir} exists`).toBe(true);
  expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
});

Then("the modal fits the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const b = (await modal(page).boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw);
  const m = await page.evaluate(() => ({ inner: window.innerWidth, root: document.documentElement.scrollWidth }));
  expect(m.root).toBe(m.inner);
});
