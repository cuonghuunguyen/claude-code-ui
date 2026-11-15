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

When("I confirm the {string} dialog", async ({ page }, name: string) => {
  await page.getByTestId(`${id(name)}-confirm`).click();
});

Then("the origin's main is the project's main", async ({ project }) => {
  await expect.poll(() => git(origin(project.name), "rev-parse", "main") === git(project.path, "rev-parse", "main"), { timeout: 60_000 }).toBe(true);
});
