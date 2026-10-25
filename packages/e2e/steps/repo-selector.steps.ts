import { expect, type Page } from "@playwright/test";
import { basename, join } from "node:path";
import { makeNestedRepo, makeSuperproject } from "../support/git-fixture.ts";
import { openProject } from "../support/flow.ts";
import { Given, Then, When } from "./fixtures.ts";

const selector = (page: Page) => page.getByTestId("repo-selector");
const items = (page: Page) => page.getByTestId("repo-tree-item");
/** "." in a feature names the own repository, whose `rel` is "". */
const itemOf = (page: Page, rel: string) => page.locator(`[data-testid="repo-tree-item"][data-rel="${rel === "." ? "" : rel}"]`);

/** Picks the project in the project chip of the open new-session tab, as a user does. */
async function chooseProject(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  const chip = page.getByTestId("project-chip");
  await expect(async () => {
    if ((await chip.textContent())?.includes(name)) return;
    try {
      await chip.click();
      await page.getByRole("option", { name }).click({ timeout: 2_000 });
      await expect(chip).toContainText(name, { timeout: 2_000 });
    } catch (e) {
      await page.keyboard.press("Escape");
      throw e;
    }
  }).toPass({ timeout: 60_000 });
}
const panel = (page: Page) => page.getByTestId("changes-panel");

Given("the scratch project also has the nested repository {string}", async ({ project }, name: string) => {
  makeNestedRepo(project.path, name, `${name} commit`);
});

const second = (project: { path: string }) => `${project.path}-second`;

Given("a second scratch project is a superproject with a dirty submodule and a nested repository", async ({ project }) => {
  makeSuperproject(second(project), "dirty-with-nested");
});

When("I open the second scratch project", async ({ page, project }) => {
  await openProject(page, second(project));
  await chooseProject(page, basename(second(project)));
});

When("I open a new session of the scratch project", async ({ page, project }) => {
  await page.getByTestId("tab-new").first().click();
  await chooseProject(page, project.name);
});

Then("the Changes toolbar has no repository selector", async ({ page }) => {
  await expect(panel(page)).toBeVisible();
  await expect(selector(page)).toHaveCount(0);
});

Then("the Changes toolbar has the repository selector", async ({ page }) => {
  await expect(selector(page)).toBeVisible({ timeout: 30_000 });
});

Then("the repository selector shows the name of the second scratch project", async ({ page, project }) => {
  await expect(selector(page)).toHaveAttribute("aria-label", new RegExp(`^Repository: ${basename(second(project))}, branch `), { timeout: 30_000 });
});

Then("the repository selector shows the name {string}", async ({ page }, name: string) => {
  const s = selector(page);
  await expect(s.locator("svg[data-icon]").first()).toBeVisible();
  await expect(s).toContainText(name);
  await expect(s).toHaveAttribute("aria-label", new RegExp(`^Repository: ${name}`));
});

Then("the repository selector shows the name of the scratch project and a branch", async ({ page, project }) => {
  await expect(selector(page)).toContainText(project.name);
  await expect(selector(page)).toHaveAttribute("aria-label", /, branch \S+/);
});

Then("the repository selector shows {string}", async ({ page }, name: string) => {
  await expect(selector(page)).toHaveAttribute("aria-label", new RegExp(`^Repository: ${name}(,|$)`), { timeout: 30_000 });
});

When("I open the repository selector", async ({ page }) => {
  await selector(page).click();
  await expect(page.getByTestId("repo-tree")).toBeVisible();
  await expect(items(page).first()).toBeVisible();
});

Then("the repository tree lists in order:", async ({ page }, table: { raw(): string[][] }) => {
  const want = table.raw().slice(1);
  await expect(items(page)).toHaveCount(want.length);
  for (const [i, [rel, icon, level]] of want.entries()) {
    const it = items(page).nth(i);
    await expect(it, `row ${i} rel`).toHaveAttribute("data-rel", rel === "." ? "" : rel);
    await expect(it.locator("[data-icon]"), `row ${i} icon`).toHaveAttribute("data-icon", icon);
    await expect(it, `row ${i} level`).toHaveAttribute("aria-level", level);
  }
  await expect(page.getByTestId("repo-tree")).toHaveAttribute("role", "tree");
  await expect(items(page).first()).toHaveAttribute("aria-expanded", "true");
  await expect(items(page).filter({ has: page.locator('[data-icon="archive"]') })).toHaveCount(1);
});

Then("the repository tree row {string} is selected", async ({ page }, rel: string) => {
  await expect(itemOf(page, rel)).toHaveAttribute("aria-selected", "true");
});

Then("the focus is on the repository tree row {string}", async ({ page }, rel: string) => {
  await expect(itemOf(page, rel)).toBeFocused();
});

When("I press {string}", async ({ page }, key: string) => {
  await page.keyboard.press(key);
});

When("I press {string} on the repository tree row {string}", async ({ page }, key: string, rel: string) => {
  await itemOf(page, rel).focus();
  await page.keyboard.press(key);
});

Then("the repository tree row {string} is collapsed", async ({ page }, rel: string) => {
  await expect(itemOf(page, rel)).toHaveAttribute("aria-expanded", "false");
});

Then("the repository tree row {string} is expanded", async ({ page }, rel: string) => {
  await expect(itemOf(page, rel)).toHaveAttribute("aria-expanded", "true");
});

Then("the repository tree is closed", async ({ page }) => {
  await expect(page.getByTestId("repo-tree")).toHaveCount(0);
});

Then("the focus is on the repository selector", async ({ page }) => {
  await expect(selector(page)).toBeFocused();
});

When("I pick the repository {string}", async ({ page }, rel: string) => {
  await itemOf(page, rel).click();
  await expect(page.getByTestId("repo-tree")).toHaveCount(0);
});

Then("the Changes list has a row ending in {string} and none ending in {string}", async ({ page }, yes: string, no: string) => {
  await expect(panel(page).locator(`[data-testid="changed-file"][data-path$="${yes}"]`).first()).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).locator(`[data-testid="changed-file"][data-path$="${no}"]`)).toHaveCount(0);
});

Then("the Against branch list offers {string} and not {string}", async ({ page }, yes: string, no: string) => {
  const trigger = page.getByTestId("diff-branch");
  await trigger.click();
  await expect(page.getByRole("option", { name: yes })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("option", { name: no })).toHaveCount(0);
});

When("I close the open menu with Escape", async ({ page }) => {
  await page.keyboard.press("Escape");
});

Then("the submodule row {string} says {string}", async ({ page }, path: string, text: string) => {
  const r = panel(page).locator(`[data-testid="changed-file"][data-path$="${path}"]`).first();
  await expect(r).toBeVisible({ timeout: 30_000 });
  if ((await r.getAttribute("aria-expanded")) !== "true") await r.click();
  await expect(page.getByTestId("submodule-dirty").first()).toContainText(text);
});

Then("the nested repository row {string} shows a repository badge and no untracked folder", async ({ page }, path: string) => {
  const r = panel(page).locator(`[data-testid="changed-file"][data-path$="${path}"]`).first();
  await expect(r).toBeVisible({ timeout: 30_000 });
  await expect(r).toContainText("repository");
  await expect(r).not.toContainText(/^U$/);
  await expect(r.getByTestId("change-stats")).toHaveCount(0);
  if ((await r.getAttribute("aria-expanded")) !== "true") await r.click();
  await expect(page.getByTestId("nested-detail").first()).toContainText(`Nested repository ${path}`);
});

When("I select the row {string} and click {string}", async ({ page }, path: string, text: string) => {
  await panel(page).locator(`[data-testid="changed-file"][data-path$="${path}"]`).first().click();
  await page.getByTestId("show-repo-changes").filter({ hasText: text }).first().click();
});

Then("the Changes header counts {string}", async ({ page }, text: string) => {
  await expect(panel(page)).toContainText(text, { timeout: 30_000 });
});

Then("the repository sheet is a full-width bottom sheet", async ({ page }) => {
  const sheet = page.getByTestId("repo-sheet");
  await expect(sheet).toBeVisible();
  const b = await sheet.boundingBox();
  const vw = page.viewportSize()!.width;
  expect(b).not.toBeNull();
  expect(Math.round(b!.x)).toBe(0);
  expect(Math.round(b!.width)).toBe(vw);
});

Then("every repository tree row is 44px high", async ({ page }) => {
  const n = await items(page).count();
  expect(n).toBeGreaterThan(1);
  for (let i = 0; i < n; i++) {
    const b = await items(page).nth(i).boundingBox();
    expect(Math.round(b!.height), `row ${i} height`).toBe(44);
  }
});

Then("the scrollWidth of the page is {int}", async ({ page }, w: number) => {
  const m = await page.evaluate(() => ({ root: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(m.root).toBe(w);
  expect(m.body).toBeLessThanOrEqual(w);
});

Then("the stored repository choice of the browser has {int} project entry", async ({ page }, n: number) => {
  const v = await page.evaluate(() => localStorage.getItem("claude-ui.repoChoice"));
  expect(Object.keys(JSON.parse(v ?? "{}"))).toHaveLength(n);
});
