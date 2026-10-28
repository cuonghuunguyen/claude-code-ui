import { expect } from "@playwright/test";
import { addSubmoduleRemotes } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const graph = (page: import("@playwright/test").Page) => page.getByTestId("graph-panel");

Given("the scratch project and its submodule have local bare remotes with remote-only branches", async ({ project }) => {
  addSubmoduleRemotes(project.path);
});

Then("the Graph filter row starts with the repository selector", async ({ page }) => {
  const first = graph(page).locator("> div").first().locator("> *").first();
  await expect(first).toHaveAttribute("data-testid", "repo-selector", { timeout: 30_000 });
});

When("I click Fetch in the Graph", async ({ page }) => {
  await graph(page).getByTestId("graph-fetch").click();
});

Then("the Graph result line says {string}", async ({ page }, text: string) => {
  await expect(graph(page).locator('[data-testid="graph-remote-result"] [role=status]')).toContainText(text, { timeout: 60_000 });
});

Then("the Graph has no result line", async ({ page }) => {
  await expect(graph(page).getByTestId("graph-remote-result")).toHaveCount(0);
});

Then("the Graph branch list offers {string}", async ({ page }, name: string) => {
  await graph(page).getByTestId("graph-filter-branch").click();
  await expect(page.getByRole("option", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
});

Then("the Graph branch list does not offer {string}", async ({ page }, name: string) => {
  await graph(page).getByTestId("graph-filter-branch").click();
  await expect(page.getByRole("option", { name: "All branches" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

When("I click {string} in the commit details", async ({ page }, text: string) => {
  await page.getByTestId("show-repo-graph").filter({ hasText: text }).click();
});

Then("the Graph selector is on its own full-width line and 44px high", async ({ page }) => {
  const s = await graph(page).getByTestId("repo-selector").boundingBox();
  const next = await graph(page).getByTestId("graph-filter-text").boundingBox();
  const vw = page.viewportSize()!.width;
  expect(s).not.toBeNull();
  expect(Math.round(s!.height)).toBeGreaterThanOrEqual(44);
  expect(s!.width).toBeGreaterThanOrEqual(vw - 48);
  expect(next!.y).toBeGreaterThanOrEqual(s!.y + s!.height - 1);
});

const pane = (page: import("@playwright/test").Page, name: string) => page.getByTestId(name === "Graph" ? "graph-panel" : "changes-panel").getByTestId("repo-selector");

Then("the {word} repository selector shows {string}", async ({ page }, name: string, repo: string) => {
  await expect(pane(page, name)).toHaveAttribute("aria-label", new RegExp(`^Repository: ${repo}(,|$)`), { timeout: 30_000 });
});

When("I open the {word} repository selector", async ({ page }, name: string) => {
  await pane(page, name).click();
  await expect(page.getByTestId("repo-tree")).toBeVisible();
  await expect(page.getByTestId("repo-tree-item").first()).toBeVisible();
});
