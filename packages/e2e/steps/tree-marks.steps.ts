import { expect, type Locator, type Page } from "@playwright/test";
import { git } from "../support/git-fixture.ts";
import { Then, When } from "./fixtures.ts";

const side = (page: Page) => page.getByTestId("side-panel");
const entry = (page: Page, rel: string): Locator => page.locator(`[data-testid="tree-entry"][data-path$="/${rel}"]`).first();

/** Desktop: a tab of the side panel. Phone: the Panes tab list. */
async function openPane(page: Page, name: RegExp): Promise<void> {
  const desktopTab = side(page).getByRole("tab", { name });
  if (await desktopTab.isVisible()) return void (await desktopTab.click());
  await page.getByRole("tablist", { name: "Panes" }).getByRole("tab", { name }).click();
}

When("I open the Files tab of the side panel", async ({ page }) => {
  await openPane(page, /^files/i);
  await expect(page.getByTestId("files-panel")).toBeVisible();
  // Narrow layouts keep the tree in a drawer.
  if (!(await page.getByTestId("file-tree").isVisible())) await page.getByTestId("toggle-tree").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await expect(page.getByTestId("tree-entry").first()).toBeVisible({ timeout: 30_000 });
});

When("I expand the tree folder {string}", async ({ page }, rel: string) => {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const row = entry(page, parts.slice(0, i).join("/"));
    await expect(row).toBeVisible({ timeout: 30_000 });
    if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
  }
});

const letter = (row: Locator) => row.getByTestId("git-mark").filter({ hasText: /^[A-Z]$/ });

Then("the tree row {string} shows the mark {string}", async ({ page }, rel: string, mark: string) => {
  const row = entry(page, rel);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(letter(row)).toHaveText(mark, { timeout: 30_000 });
});

Then("the tree row {string} has no letter mark", async ({ page }, rel: string) => {
  await expect(entry(page, rel)).toBeVisible();
  await expect(letter(entry(page, rel))).toHaveCount(0);
});

Then("the tree row {string} shows no mark at all", async ({ page }, rel: string) => {
  await expect(entry(page, rel)).toBeVisible();
  await expect(entry(page, rel).getByTestId("git-mark")).toHaveCount(0);
});

Then("the tree folder {string} shows a dot", async ({ page }, rel: string) => {
  const mark = entry(page, rel).getByTestId("git-mark");
  await expect(mark).toHaveCount(1, { timeout: 30_000 });
  await expect(mark).toHaveText("");
});

Then("the tree folder {string} has the repository icon labelled {string}", async ({ page }, rel: string, label: string) => {
  const icon = entry(page, rel).getByTestId("tree-repo-icon");
  await expect(icon).toHaveAttribute("aria-label", label, { timeout: 30_000 });
  await expect(icon).toHaveAttribute("data-kind", "nested");
});

Then("the tree folder {string} has the submodule icon labelled {string} and its checked-out commit", async ({ page, project }, rel: string, prefix: string) => {
  const sha = git(`${project.path}/${rel}`, "rev-parse", "--short", "HEAD");
  const icon = entry(page, rel).getByTestId("tree-repo-icon");
  await expect(icon).toHaveAttribute("aria-label", `${prefix} ${sha}`, { timeout: 30_000 });
  await expect(icon).toHaveAttribute("data-kind", "submodule");
});

Then("the Files tree has no repository selector", async ({ page }) => {
  await expect(page.getByTestId("files-panel").getByTestId("repo-selector")).toHaveCount(0);
});

When("I right click the tree row {string}", async ({ page }, rel: string) => {
  await entry(page, rel).click({ button: "right" });
  await expect(page.getByTestId("tree-menu")).toBeVisible();
});

When("I choose {string} in the tree menu", async ({ page }, label: string) => {
  await page.getByTestId("tree-menu").getByRole("menuitem", { name: label, exact: true }).click();
});

Then("the tree menu offers {string} and {string}", async ({ page }, a: string, b: string) => {
  const menu = page.getByTestId("tree-menu");
  await expect(menu.getByRole("menuitem", { name: a, exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: b, exact: true })).toBeVisible();
});

When("I close the tree menu", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tree-menu")).toHaveCount(0);
});

// The list shows its first row when the selection matches no row (existing behaviour, not a selected file): the folder path matches none.
Then("the Changes list has no row chosen by the tree", async ({ page }) => {
  const rows = page.getByTestId("changes-panel").getByTestId("changed-file");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  const current = page.getByTestId("changes-panel").locator('[data-testid="changed-file"][aria-current="true"]');
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("data-path", (await rows.first().getAttribute("data-path"))!);
});

Then("the Changes row ending in {string} is selected", async ({ page }, path: string) => {
  await expect(page.getByTestId("changes-panel").locator(`[data-testid="changed-file"][data-path$="${path}"][aria-current="true"]`)).toHaveCount(1, { timeout: 30_000 });
});

Then("the Changes mode is {string}", async ({ page }, mode: string) => {
  await expect(page.getByTestId("diff-mode")).toContainText(mode);
});

Then("the Graph lists the commit {string}", async ({ page }, subject: string) => {
  await expect(page.getByTestId("graph-panel").getByTestId("commit-row").filter({ hasText: subject }).first()).toBeVisible({ timeout: 30_000 });
});

When("I turn Ignore submodules {word} in Settings", async ({ page }, state: string) => {
  const want = state === "on" ? "true" : "false";
  if (!(await page.getByTestId("settings-git").isVisible())) {
    if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-group-git").click();
  }
  const sw = page.getByTestId("settings-git-ignoreSubmodules");
  if ((await sw.getAttribute("aria-checked")) !== want) await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", want);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

Then("every tree row is at least 44px high", async ({ page }) => {
  const rows = page.getByTestId("tree-entry");
  const n = await rows.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i++) expect(Math.round((await rows.nth(i).boundingBox())!.height), `row ${i}`).toBeGreaterThanOrEqual(44);
});

Then("the tree has no horizontally clipped mark", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const marks = page.getByTestId("tree-entry").locator('[data-testid="git-mark"],[data-testid="tree-repo-icon"]');
  const n = await marks.count();
  expect(n).toBeGreaterThan(3);
  for (let i = 0; i < n; i++) {
    const b = (await marks.nth(i).boundingBox())!;
    expect(b.x + b.width, `mark ${i}`).toBeLessThanOrEqual(vw);
  }
});

When("I add {string} to the Settings Git list Scan repositories", async ({ page }, folder: string) => {
  // Default scan depth is 1: a repository two levels down (tools/inner) is listed only when named in Scan repositories.
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-group-git").click();
  await expect(page.getByTestId("settings-git")).toBeVisible();
  // One daemon serves every scenario of the run: an earlier scenario may have added the folder already.
  const list = page.getByTestId("settings-git-scanRepositories");
  if (!(await list.getByTestId("settings-git-scanRepositories-item").filter({ hasText: folder }).count())) {
    await page.getByTestId("settings-git-scanRepositories-add").click();
    await page.getByTestId("settings-git-scanRepositories-input").fill(folder);
    await page.getByTestId("settings-git-scanRepositories-ok").click();
  }
  await expect(list.getByTestId("settings-git-scanRepositories-item").filter({ hasText: folder })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});
