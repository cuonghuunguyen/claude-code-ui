import { expect } from "@playwright/test";
import { makeSuperproject, type SubmoduleShas, type SubmoduleState } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const shas = new WeakMap<object, SubmoduleShas>();
const STATES: Record<string, SubmoduleState> = {
  "a moved submodule": "moved",
  "a submodule with only uncommitted edits": "dirty-only",
  "a commit that moved a submodule": "moved-committed",
  "a dirty submodule and a nested repository": "dirty-with-nested",
};

Given("the scratch project is a superproject with {}", async ({ project }, what: string) => {
  const state = STATES[what];
  expect(state, `known fixture ${what}`).toBeDefined();
  shas.set(project, makeSuperproject(project.path, state));
});

const side = (page: import("@playwright/test").Page) => page.getByTestId("side-panel");
/** Desktop: a tab of the side panel. Phone: the Panes tab list. */
async function openPane(page: import("@playwright/test").Page, name: string): Promise<void> {
  const pattern = new RegExp(`^${name}`, "i");
  const desktopTab = side(page).getByRole("tab", { name: pattern });
  if (await desktopTab.isVisible()) return void (await desktopTab.click());
  await page.getByRole("tablist", { name: "Panes" }).getByRole("tab", { name: pattern }).click();
}
const sha = (project: object) => shas.get(project)!;

When("I open the Changes tab of the side panel", async ({ page }) => {
  await openPane(page, "changes");
  await expect(page.getByTestId("changes-panel")).toBeVisible();
});

When("I choose the {string} diff mode", async ({ page }, mode: string) => {
  await page.getByTestId("diff-mode").click();
  await page.getByRole("option", { name: mode }).click();
  await expect(page.getByTestId("diff-mode")).toContainText(mode);
});

When("I open the Graph tab of the side panel", async ({ page }) => {
  await openPane(page, "graph");
  await expect(page.getByTestId("graph-panel")).toBeVisible();
});

When("I select the commit {string} in the Graph", async ({ page }, subject: string) => {
  await page.getByTestId("commit-row").filter({ hasText: subject }).first().click();
  await expect(page.getByTestId("commit-details")).toBeVisible();
});

const rowOf = (page: import("@playwright/test").Page, path: string) => page.locator(`[data-testid="changed-file"][data-path$="${path}"]`);

Then("the submodule row {string} shows a submodule badge and no line counts", async ({ page }, path: string) => {
  const r = rowOf(page, path).first();
  await expect(r).toBeVisible({ timeout: 30_000 });
  await expect(r.getByTestId("submodule-badge")).toHaveText("submodule");
  await expect(r.getByTestId("change-stats")).toHaveCount(0);
  await expect(r).not.toHaveAttribute("aria-label", /\+\d+ -\d+/);
});

Then("the detail of the submodule {string} says it is {string} at the recorded commit", async ({ page, project }, path: string, where: string) => {
  const r = rowOf(page, path).first();
  if ((await r.getAttribute("aria-expanded")) === "false") await r.click();
  else if ((await r.getAttribute("aria-expanded")) === null) await r.click();
  const d = page.getByTestId("submodule-detail");
  await expect(d).toBeVisible();
  await expect(d).toHaveText(`Submodule ${path}: ${sha(project).first} ${where}`);
});

Then("no changes error shows", async ({ page }) => {
  await expect(page.getByTestId("changes-error")).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  await expect(page.getByTestId("file-diff").getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("file-diff").locator(".text-destructive")).toHaveCount(0);
});

Then("the changes list shows {string} as a normal file with line counts", async ({ page }, path: string) => {
  const r = rowOf(page, path).first();
  await expect(r).toBeVisible({ timeout: 30_000 });
  await expect(r.getByTestId("submodule-badge")).toHaveCount(0);
  // The tree row has no counts; the panel header sums the normal file only (+1 -0).
  await expect(page.getByTestId("changes-panel")).toContainText(/\+1\s*-0/);
});

Then("the changes list has no row for {string}", async ({ page }, path: string) => {
  await expect(page.getByTestId("changes-panel")).toBeVisible();
  await expect(page.getByTestId("changes-loading")).toHaveCount(0);
  await expect(rowOf(page, path)).toHaveCount(0);
  await expect(page.getByTestId("changes-error")).toHaveCount(0);
});

Then("the commit details list the submodule {string} moved to the new commit", async ({ page, project }, path: string) => {
  const e = page.getByTestId("commit-submodule");
  await expect(e).toHaveCount(1);
  await expect(e).toHaveText(new RegExp(`^M?Submodule ${path} → ${sha(project).second}$`));
  await expect(e.locator("button")).toHaveCount(0);
  await expect(page.getByTestId("commit-file-diff")).toHaveCount(0);
});

Then("the status bar shows no added or removed lines for the submodule", async ({ page }) => {
  // Only s.txt gained one line: (+1,-0). A gitlink would add +1 -1.
  const bar = page.getByTestId("status-bar").first();
  await expect(bar).toContainText(/\(\+1,-0\)/, { timeout: 30_000 });
});
