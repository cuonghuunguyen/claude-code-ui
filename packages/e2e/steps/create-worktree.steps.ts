import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { fakeJira } from "../support/fake-jira.ts";
import { git, makeRepoWithOrigin } from "../support/git-fixture.ts";
import { runDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";

const modal = (page: Page) => page.getByTestId("create-worktree");
const row = (page: Page, path: string) => page.locator(`[data-testid="group-toggle"][title="${path}"]`).locator("xpath=ancestor::h3");
const worktreeDir = (project: string, folder: string) => join(project, ".claude", "worktrees", folder);
const TOKEN = "e2e-jira-token";

Given("the scratch project is a git repository with an origin", async ({ project }) => {
  makeRepoWithOrigin(project.path, join(runDir(), "origins", `${project.name}.git`));
});

Given("the origin of the scratch project is unreachable", async ({ project }) => {
  git(project.path, "remote", "set-url", "origin", join(runDir(), "origins", "missing.git"));
});

Given("a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3", async ({ jira }) => {
  jira.fake = await fakeJira({
    auth: `Bearer ${TOKEN}`,
    user: "Ann Example",
    issues: [
      { key: "PRJ-1", type: "Bug", summary: "Login button broken", status: "In Progress", mine: true },
      { key: "PRJ-2", type: "Story", summary: "Revisit the old try", status: "To Do", mine: true },
      { key: "PRJ-3", type: "Task", summary: "Search indexing slow", status: "To Do" },
    ],
  });
});

When("I set up Jira in Settings with the fake Jira", async ({ page, jira }) => {
  await page.keyboard.press("Control+,");
  await page.getByTestId("settings-group-jira").click();
  const url = page.getByTestId("settings-jira-url");
  await url.fill(jira.fake!.url);
  await url.press("Enter");
  const replace = page.getByTestId("settings-jira-token-replace");
  if (await replace.isVisible()) await replace.click();
  await page.getByTestId("settings-jira-token").fill(TOKEN);
  await page.getByTestId("settings-jira-token-save").click();
  await expect(page.getByTestId("settings-jira-token-set")).toHaveText(/Token set/);
  await page.getByTestId("settings-jira-test").click();
});

Then("Jira reports it is connected as {string}", async ({ page }, user: string) => {
  await expect(page.getByTestId("settings-jira-test-result")).toHaveText(`Connected as ${user}`);
});

When("I close Settings", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

When("I click the new worktree button of the scratch project", async ({ page, project }) => {
  const r = row(page, project.path);
  await r.hover();
  await r.getByTestId("project-new-worktree").click({ timeout: 60_000 });
});

When("I shift-click the new worktree button of the scratch project", async ({ page, project }) => {
  const r = row(page, project.path);
  await r.hover();
  await r.getByTestId("project-new-worktree").click({ modifiers: ["Shift"], timeout: 60_000 });
});

When("I choose {string} in the menu of the scratch project", async ({ page, project }, entry: string) => {
  // The phone's sidebar is a drawer: open it, then wait for the project row (the project list refreshes after Open project).
  // Opening a project ends in a new-session tab that closes the drawer: wait for it first.
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("open-drawer")).toBeVisible();
  await page.getByTestId("open-drawer").click();
  const r = row(page, project.path);
  await expect(r.getByTestId("project-menu")).toBeInViewport({ timeout: 60_000 });
  await r.getByTestId("project-menu").click();
  await page.getByTestId(`project-menu-${entry}`).click();
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

When("I choose the base {string}", async ({ page }, ref: string) => {
  await page.getByTestId("create-worktree-base").selectOption(ref);
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

Then("the worktree folder {string} has the same commit as {string}", async ({ project }, folder: string, ref: string) => {
  const head = git(worktreeDir(project.path, folder), "rev-parse", "HEAD");
  expect(head).toBe(git(project.path, "rev-parse", ref));
  expect(head, "not the default base").not.toBe(git(project.path, "rev-parse", "refs/heads/main"));
});

Then("the branch {string} of the worktree folder {string} tracks {string}", async ({ project }, branch: string, folder: string, upstream: string) => {
  expect(git(worktreeDir(project.path, folder), "rev-parse", "--abbrev-ref", `${branch}@{upstream}`)).toBe(upstream);
});

Then("the main branch row is disabled", async ({ page }) => {
  const r = page.locator('[data-testid="create-worktree-branch-row"][data-name="main"]');
  await expect(r).toHaveAttribute("aria-disabled", "true");
  await expect(r).toContainText(/in worktree/);
});

Then("the branch list shows {string} as {string}", async ({ page }, name: string, kind: string) => {
  const r = page.locator(`[data-testid="create-worktree-branch-row"][data-name="${name}"]`);
  await expect(r).toContainText(kind);
  await expect(r).toHaveAttribute("aria-disabled", "false");
});

Then("the modal says origin could not be fetched", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-offline")).toBeVisible({ timeout: 60_000 });
});

When("I pick the branch row {string}", async ({ page }, name: string) => {
  await page.locator(`[data-testid="create-worktree-branch-row"][data-name="${name}"]`).click();
});

Then("the Check out button is shown", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-confirm")).toHaveText(/Check out/);
});

Then("the ticket rows are {string}", async ({ page }, keys: string) => {
  const want = keys.split(",").map((k) => k.trim());
  await expect(async () => {
    const got = await page.getByTestId("create-worktree-ticket-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    expect(got.sort()).toEqual([...want].sort());
  }).toPass({ timeout: 15_000 });
});

When("I search tickets for {string}", async ({ page }, text: string) => {
  await page.getByTestId("create-worktree-ticket-search").fill(text);
});

When("I search tickets for the Jira URL of {string}", async ({ page, jira }, key: string) => {
  await page.getByTestId("create-worktree-ticket-search").fill(`${jira.fake!.url}/browse/${key}`);
});

When("I pick the ticket {string}", async ({ page }, key: string) => {
  await page.locator(`[data-testid="create-worktree-ticket-row"][data-key="${key}"]`).click();
});

Then("the ticket branch name starts with {string}", async ({ page }, prefix: string) => {
  await expect(page.getByTestId("create-worktree-ticket-branch")).toHaveValue(new RegExp(`^${prefix}`));
});

When("I change the ticket branch name to {string}", async ({ page }, name: string) => {
  await page.getByTestId("create-worktree-ticket-branch").fill(name);
});

Then("the modal offers to check out the existing branch {string}", async ({ page }, branch: string) => {
  await expect(page.getByTestId("create-worktree-existing")).toContainText(branch);
});

When("I check out the existing branch", async ({ page }) => {
  await page.getByTestId("create-worktree-checkout-existing").click();
});

Then("a worktree with a generated name exists", async ({ project }) => {
  const dir = join(project.path, ".claude", "worktrees");
  await expect(async () => {
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/^[a-z]+-[a-z]+$/);
    expect(git(join(dir, names[0]!), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`worktree-${names[0]}`);
  }).toPass({ timeout: 30_000 });
});

Then("the new-session tab runs in a worktree with a generated name", async ({ page }) => {
  await expect(page.getByTestId("worktree-chip")).toContainText(/worktree-[a-z]+-[a-z]+/, { timeout: 60_000 });
});

Then("the modal fits the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const b = (await modal(page).boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw);
  const m = await page.evaluate(() => ({ inner: window.innerWidth, root: document.documentElement.scrollWidth }));
  expect(m.root).toBe(m.inner);
});
