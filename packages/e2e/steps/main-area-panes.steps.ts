import { expect, type Locator, type Page } from "@playwright/test";
import { makeRepoWithTwoCommits } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const PREFIX: Record<string, string> = { Plan: "plan", Changes: "changes", Files: "files", "Git graph": "graph", Terminal: "terminal" };
const PANE: Record<string, string> = { Plan: "plan", Files: "files", "Git graph": "graph", Changes: "changes", Terminal: "terminal" };
const side = (page: Page) => page.getByTestId("side-panel");
const kindTabs = (page: Page, kind: string) => page.locator(`[data-testid="tab"][data-tab-id^="${PREFIX[kind]}:"]`);
const kindButton = (page: Page, kind: string) => kindTabs(page, kind).first().locator('[role="tab"]');
const body = (page: Page, kind: string) => page.locator(`[data-pane-tab-body^="${PREFIX[kind]}:"]`);
const sessionTabs = (page: Page) =>
  page.locator('[data-testid="tab"]:not([data-tab-id^="files:"]):not([data-tab-id^="graph:"]):not([data-tab-id^="plan:"]):not([data-tab-id^="terminal:"]):not([data-tab-id=""])').filter({ has: page.locator('[role="tab"]') });
let remembered = "";

async function stripIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="tab-strip"] [data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id") ?? ""));
}

const menuOf = (loc: Locator) => loc.click({ button: "right" });

Given("the scratch project is a git repository with two commits", async ({ project }) => {
  makeRepoWithTwoCommits(project.path);
});

When("I move the {string} pane to the main area from its tab menu", async ({ page }, kind: string) => {
  const dock = page.locator(`[data-testid="side-panel"] [data-testid="pane-${PANE[kind]}"], [data-testid="bottom-panel"] [data-testid="pane-${PANE[kind]}"]`);
  await menuOf(dock.first());
  await page.getByTestId("pane-move-main").click();
  await expect(kindTabs(page, kind)).toHaveCount(1);
});

Then("the {string} tab opens right of its session tab and has the focus", async ({ page }, kind: string) => {
  await expect(kindTabs(page, kind)).toHaveCount(1);
  await expect(kindButton(page, kind)).toHaveAttribute("aria-selected", "true");
  const ids = await stripIds(page);
  const at = ids.findIndex((i) => i.startsWith(`${PREFIX[kind]}:`));
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe(ids[at]!.slice(PREFIX[kind]!.length + 1));
});

Then("the {string} tab is labeled with the scratch project name", async ({ page, project }, kind: string) => {
  await expect(kindTabs(page, kind).first()).toContainText(`${kind} · ${project.name}`);
});

Then("the side panel has no {string} tab", async ({ page }, kind: string) => {
  await expect(side(page)).toBeVisible();
  await expect(side(page).getByTestId(`pane-${PANE[kind]}`)).toHaveCount(0);
});

Then("the side panel lists the {string} tab", async ({ page }, kind: string) => {
  await expect(side(page).getByTestId(`pane-${PANE[kind]}`)).toBeVisible();
});

Then("there is one {string} tab", async ({ page }, kind: string) => {
  await expect(kindTabs(page, kind)).toHaveCount(1);
});

Then("there is no {string} tab", async ({ page }, kind: string) => {
  await expect(kindTabs(page, kind)).toHaveCount(0);
});

Then("the {string} tab has the focus", async ({ page }, kind: string) => {
  await expect(kindButton(page, kind)).toHaveAttribute("aria-selected", "true");
  await expect(body(page, kind)).toBeVisible();
});

When("I click the {string} tab", async ({ page }, kind: string) => {
  await kindButton(page, kind).click();
});

When("I click the first session tab", async ({ page }) => {
  await sessionTabs(page).first().locator('[role="tab"]').click();
});

When("I click the second session tab", async ({ page }) => {
  await expect(sessionTabs(page)).toHaveCount(2);
  await sessionTabs(page).nth(1).locator('[role="tab"]').click();
});

When("I close the {string} tab from its tab menu", async ({ page }, kind: string) => {
  await menuOf(kindTabs(page, kind).first());
  await page.getByRole("menuitem", { name: "Close tab", exact: true }).click();
});

When("I choose {string} in the menu of the {string} tab", async ({ page }, label: string, kind: string) => {
  await menuOf(kindTabs(page, kind).first());
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

When("I open the file {string} in the Files tab", async ({ page }, name: string) => {
  await body(page, "Files").locator(`[data-testid="tree-entry"][data-path$="${name}"]`).first().click();
});

Then("the Files tab shows the file {string}", async ({ page }, name: string) => {
  const files = body(page, "Files");
  await expect(files).toBeVisible();
  await expect(files.locator('[data-testid="editor-tab"][aria-selected="true"]')).toContainText(name);
  await expect(files.getByTestId("code-editor")).toBeVisible();
});

When("I open the New session tab", async ({ page }) => {
  await page.getByTestId("tab-new").first().click();
  await expect(page.getByTestId("new-session-tab")).toBeVisible();
});

When("I select the first commit in the Git graph", async ({ page }) => {
  const graph = body(page, "Git graph");
  const row = graph.getByTestId("commit-row").first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  remembered = ((await row.textContent()) ?? "").replace(/\s+/g, " ").trim();
  await row.click();
  await expect(graph.getByTestId("commit-details")).toBeVisible();
});

Then("the Git graph keeps the selected commit", async ({ page }) => {
  const graph = body(page, "Git graph");
  await expect(graph).toBeVisible();
  await expect(graph.getByTestId("commit-details")).toBeVisible();
  expect(remembered.length).toBeGreaterThan(0);
  await expect(graph.getByTestId("commit-details")).toContainText(/second commit|first commit/);
  const subject = remembered.includes("second commit") ? "second commit" : "first commit";
  await expect(graph.getByTestId("commit-details")).toContainText(subject);
});

When("I split the two sessions one above the other", async ({ page }) => {
  await menuOf(sessionTabs(page).nth(1));
  await page.getByTestId("tab-menu-splitDown").click();
});

Then("the session area is split", async ({ page }) => {
  await expect(page.locator('[data-testid="session-area"][data-split]')).toBeVisible();
});

Then("the session area is not split", async ({ page }) => {
  await expect(page.locator('[data-testid="session-area"][data-split]')).toHaveCount(0);
});

Then("the side panel has no Changes {string} item", async ({ page }, item: string) => {
  expect(item).toBe("Move to main area");
  await menuOf(side(page).getByTestId("pane-changes"));
  await expect(page.getByTestId("pane-move")).toBeVisible();
  await expect(page.getByTestId("pane-move-main")).toHaveCount(0);
});

When("I dismiss the open toasts", async ({ page }) => {
  const close = page.getByTestId("toast").getByRole("button", { name: "Dismiss" });
  for (let n = await close.count(); n > 0; n = await close.count()) await close.first().click();
  await expect(page.getByTestId("toast")).toHaveCount(0);
});

Then("the sidebar lists the scratch project", async ({ page, project }) => {
  if (await page.getByTestId("open-drawer").isVisible()) return;
  await expect(page.getByTestId("session-group").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("session-group").first()).toHaveAttribute("data-cwd", project.path);
});

Then("the tab switcher lists a {string} row", async ({ page }, kind: string) => {
  await expect(page.getByRole("option").filter({ hasText: `${kind} ·` })).toHaveCount(1);
});

When("I pick the {string} row in the tab switcher", async ({ page }, kind: string) => {
  await page.getByRole("option").filter({ hasText: `${kind} ·` }).click();
  await expect(body(page, kind)).toBeVisible();
});
