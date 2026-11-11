import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { git } from "../support/git-fixture.ts";
import { projectsRoot, runDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";

const origin = (name: string) => join(projectsRoot(runDir()), `${name}-origins`, "origin.git");
const graph = (page: Page) => page.getByTestId("graph-panel");
const ITEMS = { Push: "branch-push", "Force push…": "branch-force-push", Pull: "branch-pull" } as const;
const DIALOGS = { push: "git-push", "force push": "git-force-push", pull: "git-pull" } as const;
const dlg = (page: Page, name: string) => page.getByTestId(`${DIALOGS[name as keyof typeof DIALOGS]}-dialog`);
const id = (name: string) => DIALOGS[name as keyof typeof DIALOGS];

Given("the scratch project's main has the local commit {string}", async ({ project }, s: string) => {
  git(project.path, "commit", "--allow-empty", "-m", s);
});

Given("the origin's main has the commit {string} and the project fetched it", async ({ project }, s: string) => {
  const seed = `${origin(project.name)}.seed`;
  git(seed, "checkout", "main");
  git(seed, "commit", "--allow-empty", "-m", s);
  git(seed, "push", "origin", "main");
  git(project.path, "fetch", "origin");
});

Given("the branch {string} tracks origin and is checked out in another worktree", async ({ project }, b: string) => {
  git(project.path, "branch", "--track", b, `origin/${b}`);
  git(project.path, "worktree", "add", `${project.path}-wt`, b);
});

When("I choose {string} in the Graph branch filter", async ({ page }, name: string) => {
  await graph(page).getByTestId("graph-filter-branch").click();
  await page.getByRole("option", { name, exact: true }).click();
});

When("I open the branch menu on the chip {string}", async ({ page }, ref: string) => {
  await graph(page).locator(`[data-testid="commit-ref"][data-ref="${ref}"]`).first().click({ button: "right" });
  const menu = page.getByTestId("branch-menu");
  await expect(menu).toBeVisible({ timeout: 30_000 });
  await expect(menu.getByText("Loading…")).toHaveCount(0, { timeout: 30_000 });
});

When("I pick {string} in the branch menu", async ({ page }, item: string) => {
  await page.getByTestId(ITEMS[item as keyof typeof ITEMS]).click();
});

Then("the {string} dialog shows the command {string}", async ({ page }, name: string, text: string) => {
  await expect(dlg(page, name).getByTestId("git-command")).toContainText(text, { timeout: 30_000 });
});

Then("the force push dialog leases origin's main", async ({ page, project }) => {
  const sha = git(project.path, "rev-parse", "origin/main");
  await expect(dlg(page, "force push").getByTestId("git-command")).toContainText(`--force-with-lease=refs/heads/main:${sha}`, { timeout: 30_000 });
});

When("I cancel the {string} dialog", async ({ page }, name: string) => {
  await page.getByTestId(`${id(name)}-cancel`).click();
  await expect(dlg(page, name)).toHaveCount(0);
});

When("I confirm the {string} dialog", async ({ page }, name: string) => {
  await page.getByTestId(`${id(name)}-confirm`).click();
});

Then("the origin's main is the project's main", async ({ project }) => {
  await expect.poll(() => git(origin(project.name), "rev-parse", "main") === git(project.path, "rev-parse", "main"), { timeout: 60_000 }).toBe(true);
});

Then("the origin's main is not the project's main", async ({ project }) => {
  expect(git(origin(project.name), "rev-parse", "main")).not.toBe(git(project.path, "rev-parse", "main"));
});

Then("the branch menu item {string} is disabled and says {string}", async ({ page }, item: string, text: string) => {
  const el = page.getByTestId(ITEMS[item as keyof typeof ITEMS]);
  await expect(el).toHaveAttribute("data-disabled", /.*/);
  await expect(el).toContainText(text);
});

Then("the Graph shows the error {string}", async ({ page }, text: string) => {
  await expect(graph(page).locator('[data-testid="graph-remote-result"] [role=alert]')).toContainText(text, { timeout: 60_000 });
});

Then("every branch menu item is at least 44px high", async ({ page }) => {
  const items = page.getByTestId("branch-menu").locator("[role=menuitem]");
  const n = await items.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) expect((await items.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(43.5);
});

When("I dismiss the Graph result line", async ({ page }) => {
  const r = graph(page).getByTestId("graph-remote-result");
  await r.getByRole("button").last().click();
  await expect(r).toHaveCount(0);
});
