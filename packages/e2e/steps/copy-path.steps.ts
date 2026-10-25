import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { memoWorktreePath } from "../support/copy-path.ts";
import { Given, Then, When, type Project } from "./fixtures.ts";

// Rows of this scenario's project (the daemon is shared by the run: match the path exactly).
const projectRow = (page: Page, p: Project): Locator => page.locator(`[data-testid="group-toggle"][title="${p.path}"]`).locator("xpath=ancestor::h3");
const worktreeRow = (page: Page, path: string): Locator => page.locator(`[data-testid="worktree-row"][data-path="${path}"]`).getByTestId("worktree-toggle");
const wtPath = (p: Project, name: string) => join(p.path, ".claude", "worktrees", name);
const MENUS = '[data-testid="group-menu"], [data-testid="worktree-context-menu"], [role="menu"]';
const menu = (page: Page): Locator => page.locator(MENUS).locator("visible=true").last();

Given("the browser may use the clipboard", async ({ page, daemon }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: daemon.origin });
});

// Denial is stubbed in the browser context (before the app loads), as NotAllowedError, as an insecure context or a denied prompt gives.
Given("the browser denies the clipboard", async ({ page }) => {
  await page.addInitScript(() => {
    const deny = () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
    try {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: deny, readText: deny } });
    } catch {}
  });
});

When("I right click the scratch project row", async ({ page, project }) => {
  // The project list refreshes some seconds after Open project (more with earlier scenarios' projects listed): wait for the row.
  const row = projectRow(page, project).locator('[data-testid="group-toggle"]');
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
});

When("I right click the scratch worktree row", async ({ page, project, memo }) => {
  const row = worktreeRow(page, wtPath(project, memoWorktreePath(memo)));
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.click({ button: "right" });
  await expect(menu(page)).toBeVisible();
});

When("I focus the scratch project row and press {string}", async ({ page, project }, key: string) => {
  const btn = projectRow(page, project).locator('[data-testid="group-toggle"]');
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.focus();
  await page.keyboard.press(key);
  await expect(menu(page)).toBeVisible();
});

When("I focus the scratch worktree row and press {string}", async ({ page, project, memo }, key: string) => {
  const row = worktreeRow(page, wtPath(project, memoWorktreePath(memo)));
  await expect(row).toBeVisible({ timeout: 60_000 });
  await row.focus();
  await page.keyboard.press(key);
  await expect(menu(page)).toBeVisible();
});

When("I close the row menu", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.locator(MENUS).locator("visible=true")).toHaveCount(0);
});

When("I open the kebab menu of the scratch project row", async ({ page, project }) => {
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("open-drawer").click();
  const r = projectRow(page, project);
  await expect(r.getByTestId("project-menu")).toBeInViewport({ timeout: 60_000 });
  await r.getByTestId("project-menu").click();
  await expect(menu(page)).toBeVisible();
});

When("I open the kebab menu of the scratch worktree row", async ({ page, project, memo }) => {
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="menu"]').locator("visible=true")).toHaveCount(0);
  const row = page.locator(`[data-testid="worktree-row"][data-path="${wtPath(project, memoWorktreePath(memo))}"]`);
  await expect(row.getByTestId("worktree-menu")).toBeVisible({ timeout: 60_000 });
  await row.getByTestId("worktree-menu").click();
  await expect(menu(page)).toBeVisible();
});

When("I choose {string} in the row menu", async ({ page }, name: string) => {
  await menu(page).getByRole("menuitem", { name, exact: true }).click();
});

Then("the row menu has {string} in its own section near the top", async ({ page }, name: string) => {
  const m = menu(page);
  const item = m.getByRole("menuitem", { name, exact: true });
  await expect(item).toBeVisible();
  // Own section: a separator right before and after the item; near the top: at most 4 items before it (New session/worktree entries).
  const info = await m.evaluate((el, label) => {
    const kids = [...el.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="separator"]')];
    const i = kids.findIndex((k) => k.getAttribute("role") === "menuitem" && k.textContent?.trim() === label);
    return { i, before: kids[i - 1]?.getAttribute("role"), after: kids[i + 1]?.getAttribute("role"), items: kids.slice(0, i).filter((k) => k.getAttribute("role") !== "separator").length, total: kids.filter((k) => k.getAttribute("role") !== "separator").length };
  }, name);
  expect(info.i).toBeGreaterThanOrEqual(0);
  expect(info.before, "separator before").toBe("separator");
  expect(info.after, "separator after").toBe("separator");
  expect(info.items).toBeLessThanOrEqual(4);
  expect(info.items, "not the first section's only item list end").toBeLessThan(info.total - 1);
});

Then("the row menu items are at least 44px high", async ({ page }) => {
  const items = menu(page).getByRole("menuitem");
  const n = await items.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const b = await items.nth(i).boundingBox();
    expect(b!.height, `item ${i} height`).toBeGreaterThanOrEqual(43.5);
  }
});

Then("the page is exactly 390px wide", async ({ page }) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

Then("the clipboard holds the scratch project path", async ({ page, project }) => {
  await expect.poll(() => readClipboard(page)).toBe(project.path);
});

Then("the clipboard holds the scratch worktree path", async ({ page, project, memo }) => {
  await expect.poll(() => readClipboard(page)).toBe(wtPath(project, memoWorktreePath(memo)));
});

Then("a toast says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("toast").filter({ hasText: text }).last()).toHaveText(new RegExp(`^${text}`));
});

Then("an error toast says {string} and ends with the scratch project path", async ({ page, project }, text: string) => {
  const t = page.getByTestId("toast").filter({ hasText: text }).last();
  await expect(t).toBeVisible();
  expect((await t.innerText()).trim().endsWith(project.path)).toBe(true);
});
