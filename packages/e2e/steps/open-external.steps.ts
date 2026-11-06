import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { openLog, runDir } from "../support/paths.ts";
import { Then, When } from "./fixtures.ts";

const ids = (list: string): string[] => list.split(",").map((x) => x.trim());
/** The visible menu: the last role=menu popup. */
const menu = (page: Page): Locator => page.locator('[role="menu"]').locator("visible=true").last();
/** Menu items of the open-in-app section by how (reveal, default, an editor id), whichever menu holds them. */
const ext = (page: Page, prefix: string): Locator => menu(page).locator(`[data-testid^="${prefix}"]`);
const offered = async (page: Page, prefix: string, how: string[]) => {
  const got = await ext(page, prefix).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.slice(e.getAttribute("data-testid")!.lastIndexOf("-") + 1)));
  // Editors detected on the machine may add entries between reveal and default.
  expect(got.filter((x) => how.includes(x))).toEqual(how);
};

Then("the menu offers the open-in-app items {string}", async ({ page }, list: string) => {
  const open = menu(page);
  await expect(open).toBeVisible();
  const prefix = (await page.getByTestId("tree-menu").count()) ? "ext-menu-" : (await open.locator('[data-testid^="tab-menu-ext"]').count()) ? "tab-menu-ext" : "row-ext-menu-";
  await expect(ext(page, prefix).first()).toBeVisible();
  const how = ids(list);
  if (prefix === "tab-menu-ext") return expect((await ext(page, prefix).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.split(":")[1]))).filter((x) => how.includes(x))).toEqual(how);
  await offered(page, prefix, how);
  if (!how.includes("default")) await expect(open.locator(`[data-testid="${prefix}default"]`)).toHaveCount(0);
});

When("I choose the open-in-app item {string}", async ({ page }, how: string) => {
  await page.getByTestId(`ext-menu-${how}`).click();
});

When("I open the menu of the Changes row {string}", async ({ page }, name: string) => {
  await page.getByTestId("changed-file").and(page.locator(`[data-path$="/${name}"]`)).first().click({ button: "right" });
  await expect(page.getByTestId("row-open")).toBeVisible();
});

Then("the row menu lists {string}", async ({ page }, list: string) => {
  await expect(menu(page).getByRole("menuitem").filter({ hasText: /^(Open|Copy path|Copy relative path)$/ })).toHaveText(ids(list));
});

Then("the row menu offers the open-in-app items {string}", async ({ page }, list: string) => {
  await offered(page, "row-ext-menu-", ids(list));
});

When("I choose the open-in-app item {string} in the row menu", async ({ page }, how: string) => {
  await page.getByTestId(`row-ext-menu-${how}`).click();
});

When("I open the menu of the file tab {string}", async ({ page }, name: string) => {
  await page.locator('[data-testid="tab"][data-tab-id^="file:"]').filter({ hasText: name }).click({ button: "right" });
  await expect(menu(page)).toBeVisible();
});

Then("the tab menu offers the open-in-app items {string}", async ({ page }, list: string) => {
  const how = ids(list);
  await expect(page.getByTestId("tab-menu-ext:reveal")).toBeVisible();
  for (const h of how) await expect(page.getByTestId(`tab-menu-ext:${h}`)).toBeVisible();
});

// The daemon appends the command it would start to CLAUDE_UI_OPEN_LOG (never launches an app). Reveal: the path itself (macOS, Windows) or its folder (Linux).
Then("the daemon started a file manager command for {string}", async ({ project }, rel: string) => {
  const file = realpathSync(join(project.path, rel));
  const want = process.platform === "linux" ? dirname(file) : file;
  await expect
    .poll(() => (existsSync(openLog(runDir())) ? readFileSync(openLog(runDir()), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[] }) : []).some((c) => c.args.some((a) => a.includes(want))), { timeout: 10_000 })
    .toBe(true);
});
