import { expect, type Page } from "@playwright/test";
import { makeNestedRepo } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const dialog = (page: Page) => page.getByTestId("settings-dialog");
const row = (key: string) => `settings-git-${key}`;
const LISTS = { "Repository scan ignored folders": "repositoryScanIgnoredFolders", "Scan repositories": "scanRepositories", "Ignored repositories": "ignoredRepositories" } as const;
const listId = (label: string) => {
  const key = LISTS[label as keyof typeof LISTS];
  expect(key, `known list setting ${label}`).toBeDefined();
  return row(key);
};

Given("the scratch project is a folder that holds the repositories {string}", async ({ project }, names: string) => {
  const list = names.split(",").map((n) => n.trim());
  list.forEach((n, i) => makeNestedRepo(project.path, n, `${n} commit`, i === 0));
});

When("I add the repository {string} on disk", async ({ project }, name: string) => {
  makeNestedRepo(project.path, name, `${name} commit`, true);
});

When("I open Settings and choose the Git group", async ({ page }) => {
  if (!(await dialog(page).isVisible())) {
    if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
    await page.getByTestId("open-settings").click();
  }
  await expect(dialog(page)).toBeVisible();
  await page.getByTestId("settings-group-git").click();
  await expect(page.getByTestId("settings-git")).toBeVisible();
});

When("I reload the page and open Settings Git again", async ({ page }) => {
  await page.reload();
  await expect(page.getByTestId("connection-status").first()).toHaveText(/^\s*connected\s*$/, { timeout: 60_000 });
  if (await page.getByTestId("open-drawer").isVisible()) await page.getByTestId("open-drawer").click();
  await page.getByTestId("open-settings").click();
  await page.getByTestId("settings-group-git").click();
  await expect(page.getByTestId("settings-git")).toBeVisible();
});

Then("the Git group lists the settings:", async ({ page }, table: { raw(): string[][] }) => {
  for (const [label, kind, value] of table.raw().slice(1)) {
    const section = page.getByTestId("settings-git");
    await expect(section.getByText(label, { exact: true }).first(), `${label} label`).toBeVisible();
    const id = `settings-git-${KEYS[label]}`;
    const el = page.getByTestId(id);
    if (kind === "select") await expect(el).toContainText(value);
    else if (kind === "number") await expect(el).toHaveValue(value);
    else if (kind === "switch") await expect(el).toHaveAttribute("aria-checked", value === "on" ? "true" : "false");
    else await expect(el.getByTestId(`${id}-item`)).toHaveCount(value === "none" ? 0 : value.split(",").length);
  }
});

const KEYS: Record<string, string> = {
  "Auto repository detection": "autoRepositoryDetection",
  "Repository scan max depth": "repositoryScanMaxDepth",
  "Repository scan ignored folders": "repositoryScanIgnoredFolders",
  "Scan repositories": "scanRepositories",
  "Ignored repositories": "ignoredRepositories",
  "Detect submodules": "detectSubmodules",
  "Detect submodules limit": "detectSubmodulesLimit",
  "Ignore submodules": "ignoreSubmodules",
  "Open repository in parent folders": "openRepositoryInParentFolders",
};

Then("the parent folders setting notes the difference from VS Code", async ({ page }) => {
  await expect(page.locator(`#${row("openRepositoryInParentFolders")}-hint`)).toContainText("VS Code: prompt");
});

When("I add the item {string} to {string}", async ({ page }, text: string, label: string) => {
  const id = listId(label);
  await page.getByTestId(`${id}-add`).click();
  await page.getByTestId(`${id}-input`).fill(text);
  await page.getByTestId(`${id}-ok`).click();
});

When("I try to add the item {string} to {string}", async ({ page }, text: string, label: string) => {
  const id = listId(label);
  const input = page.getByTestId(`${id}-input`);
  if (!(await input.isVisible())) await page.getByTestId(`${id}-add`).click();
  await input.fill(text);
  await page.getByTestId(`${id}-ok`).click();
});

When("I edit the item {string} of {string} to {string}", async ({ page }, from: string, label: string, to: string) => {
  const id = listId(label);
  await page.getByTestId(`${id}-item`).filter({ hasText: from }).getByTestId(`${id}-edit`).click();
  const input = page.getByTestId(`${id}-input`);
  await expect(input).toHaveValue(from);
  await input.fill(to);
  await input.press("Enter");
});

When("I remove the item {string} from {string}", async ({ page }, text: string, label: string) => {
  const id = listId(label);
  await page.getByTestId(`${id}-item`).filter({ hasText: text }).getByTestId(`${id}-remove`).click();
});

Then("{string} lists the items {string}", async ({ page }, label: string, items: string) => {
  const id = listId(label);
  const want = items === "none" ? [] : items.split(",");
  await page.getByTestId(id).scrollIntoViewIfNeeded();
  await expect(page.getByTestId(`${id}-item`)).toHaveCount(want.length);
  for (const w of want) await expect(page.getByTestId(`${id}-item`).filter({ hasText: w })).toHaveCount(1);
});

Then("the settings dialog shows an error", async ({ page }) => {
  await expect(dialog(page).locator('[role="alert"], [data-kind="error"]').first()).toBeVisible();
});

Then("the Graph shows the commit {string}", async ({ page }, subject: string) => {
  await expect(page.getByTestId("commit-row").filter({ hasText: subject }).first()).toBeVisible({ timeout: 30_000 });
});

Then("the Graph does not show the commit {string}", async ({ page }, subject: string) => {
  await expect(page.getByTestId("commit-row").filter({ hasText: subject })).toHaveCount(0);
});

When("I click Refresh in the Graph", async ({ page }) => {
  await page.getByTestId("graph-panel").getByRole("button", { name: "Refresh" }).click();
});

When("I click Reload from disk in the Changes tab", async ({ page }) => {
  await page.getByTestId("changes-panel").getByRole("button", { name: "Reload from disk" }).first().click();
});

Then("the changes list has a row ending in {string}", async ({ page }, path: string) => {
  await expect(page.locator(`[data-testid="changed-file"][data-path$="${path}"]`).first()).toBeVisible({ timeout: 30_000 });
});

Then("the side panel has a Graph tab", async ({ page }) => {
  const re = /^graph/i;
  const desktop = page.getByTestId("side-panel").getByRole("tab", { name: re });
  const phone = page.getByRole("tablist", { name: "Panes" }).getByRole("tab", { name: re });
  await expect(desktop.or(phone).first()).toBeVisible({ timeout: 30_000 });
});

Then("every list row button in Settings is at least 44px", async ({ page }) => {
  const id = row("repositoryScanIgnoredFolders");
  for (const t of [`${id}-edit`, `${id}-remove`, `${id}-add`]) {
    const b = await page.getByTestId(t).first().boundingBox();
    expect(b, t).not.toBeNull();
    expect(Math.round(b!.height), `${t} height`).toBeGreaterThanOrEqual(44);
    if (t !== `${id}-add`) expect(Math.round(b!.width), `${t} width`).toBeGreaterThanOrEqual(44);
  }
});

Then("the Git settings panel does not scroll sideways", async ({ page }) => {
  const m = await page.getByTestId("settings-panel").evaluate((e) => ({ s: e.scrollWidth, c: e.clientWidth }));
  expect(m.s).toBeLessThanOrEqual(m.c);
});

When("I scroll the Git settings to the end", async ({ page }) => {
  await page.getByTestId(row("openRepositoryInParentFolders")).scrollIntoViewIfNeeded();
});
