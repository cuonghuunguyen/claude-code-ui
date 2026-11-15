// Acceptance steps for GH-452 (Create worktree edge cases), GH-461 (Clean up), GH-463 (status cache), GH-462 (Remove worktree).
// Repositories are prepared with git commands in the scenario's scratch project; everything else goes through the UI.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { git, makeRepoWithOrigin } from "../support/git-fixture.ts";
import { projectsRoot, runDir } from "../support/paths.ts";
import { Given, Then, When, type Project } from "./fixtures.ts";
import { cssStr } from "../support/css.ts";
const wtDir = (p: Project, name: string) => join(p.path, ".claude", "worktrees", name);
const phone = (page: Page) => page.viewportSize()!.width < 500;
// Rows of earlier scenarios stay in the shared daemon's sidebar: a row is always looked up by the scratch project's folder.
const worktreeRow = (page: Page, project: Project, branch: string | RegExp) =>
  page.locator(`[data-testid="worktree-row"][data-path^="${cssStr(join(project.path, ".claude", "worktrees"))}"]`).filter({ hasText: branch });

// ---- repositories for Clean up and Remove -------------------------------------------------------------------------
const addWorktree = (p: Project, name: string) => {
  git(p.path, "worktree", "add", "-b", name, join(".claude", "worktrees", name));
};

Given("the scratch project ignores .claude and *.log", async ({ project }) => {
  writeFileSync(join(project.path, ".gitignore"), ".claude/\n*.log\n");
  git(project.path, "add", ".gitignore");
  git(project.path, "commit", "-m", "ignore");
  git(project.path, "push", "origin", "main");
});

Given("the scratch project has a clean worktree {string}", async ({ project }, name: string) => addWorktree(project, name));

Given("the scratch project has a worktree {string} with an uncommitted edit", async ({ project }, name: string) => {
  addWorktree(project, name);
  writeFileSync(join(wtDir(project, name), "README.md"), "edited\n");
});

Given("the worktree {string} has {int} ignored files", async ({ project }, name: string, n: number) => {
  const dir = join(wtDir(project, name), "build");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.log`), "x\n");
});

// A timeline of the dialog's DOM (fetch line, rows with badge and checkbox state), kept in the page so a state that lasts
// a few milliseconds is still seen.
const WATCH = () => {
  const w = window as unknown as { __cl?: unknown[]; __rm?: unknown[]; __watch?: boolean };
  if (w.__watch) return;
  w.__watch = true;
  w.__cl = [];
  w.__rm = [];
  const t0 = performance.now();
  const snap = () => {
    const d = document.querySelector('[data-testid="cleanup-dialog"]');
    if (d)
      w.__cl!.push({
        t: Math.round(performance.now() - t0),
        fetch: [...d.querySelectorAll('[data-testid="cleanup-fetch"]')].map((e) => e.textContent).join("|"),
        rows: [...d.querySelectorAll('[data-testid="cleanup-row"]')].map((r) => ({ text: r.textContent ?? "", badge: r.querySelector('[data-testid="cleanup-badge"]')?.textContent ?? "", disabled: !!r.querySelector<HTMLInputElement>('[data-testid="cleanup-check"]')?.disabled })),
      });
    if (/Worktree \S+ not removed/.test(document.body.textContent ?? "")) (w as { __refused?: string }).__refused = (document.body.textContent ?? "").match(/Worktree \S+ not removed[^.]*/)![0];
    const rd = document.querySelector('[data-testid="remove-worktree-dialog"]');
    const rows = [...document.querySelectorAll('[data-testid="worktree-row"]')].map((r) => ({ path: (r as HTMLElement).dataset.path ?? "", removing: !!r.querySelector('[data-testid="worktree-removing"]'), dim: !!r.querySelector("[data-removing]") }));
    w.__rm!.push({ t: Math.round(performance.now() - t0), dialog: rd ? { text: rd.textContent ?? "", confirm: rd.querySelector<HTMLButtonElement>('[data-testid="remove-worktree-confirm"]')?.disabled ?? null } : null, rows });
  };
  new MutationObserver(snap).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  setInterval(snap, 100); // a state that settles without a later mutation is still recorded
};
type RmSnap = { t: number; dialog: { text: string; confirm: boolean | null } | null; rows: { path: string; removing: boolean; dim: boolean }[] };
const rmTimeline = (page: Page) => page.evaluate(() => (window as unknown as { __rm: unknown[] }).__rm) as Promise<RmSnap[]>;

// ---- Remove worktree ------------------------------------------------------------------------------------------------
async function removeDialog(page: Page, project: Project, branch: string | RegExp) {
  await page.evaluate(WATCH);
  const row = worktreeRow(page, project, branch);
  if (phone(page)) {
    await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
    const menu = row.first().getByTestId("worktree-menu");
    await expect(async () => {
      if (!(await menu.isVisible()) || !(await menu.evaluate((e) => e.getBoundingClientRect().right <= innerWidth && e.getBoundingClientRect().left >= 0))) await page.getByTestId("open-drawer").click();
      await expect(menu).toBeInViewport({ timeout: 1500 });
    }).toPass({ timeout: 30_000 });
    await menu.click();
    await page.getByTestId("worktree-menu-remove").click();
  } else {
    await row.first().hover({ timeout: 60_000 });
    await row.first().getByTestId("worktree-remove").click({ timeout: 60_000 });
  }
  await expect(page.getByTestId("remove-worktree-dialog")).toBeVisible({ timeout: 2000 });
}

When("I open the Remove worktree dialog of {string}", async ({ page, project }, branch: string) => {
  await page.evaluate(() => (window as unknown as { __t?: number }).__t = performance.now());
  await removeDialog(page, project, branch);
});

Then("the Remove worktree dialog is titled {string}", async ({ page }, title: string) => {
  await expect(page.getByTestId("remove-worktree-dialog")).toContainText(title);
});

Then("the Remove worktree dialog showed Checking… with Remove worktree disabled before its result", async ({ page }) => {
  const tl = await rmTimeline(page);
  const d = tl.filter((s) => s.dialog);
  const i = d.findIndex((s) => s.dialog!.text.includes("Checking…") && s.dialog!.confirm === true);
  expect(i, "Checking… with Remove disabled seen").toBeGreaterThanOrEqual(0);
  expect(d.slice(i).some((s) => !s.dialog!.text.includes("Checking…")), "result replaced Checking…").toBe(true);
});

Then("the Remove worktree dialog shows its result and Remove worktree is enabled", async ({ page }) => {
  const dlg = page.getByTestId("remove-worktree-dialog");
  await expect(dlg).not.toContainText("Checking…", { timeout: 60_000 });
  await expect(page.getByTestId("remove-worktree-confirm")).toBeEnabled();
});

Then("the Remove worktree dialog says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("remove-worktree-dialog")).toContainText(text, { timeout: 60_000 });
});

Then("the Remove worktree dialog fits the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const b = (await page.getByTestId("remove-worktree-dialog").boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(vw);
});

When("I confirm the removal", async ({ page }) => {
  await page.getByTestId("remove-worktree-confirm").click();
});

Then("the Remove worktree dialog closes at once", async ({ page }) => {
  await expect(page.getByTestId("remove-worktree-dialog")).toBeHidden({ timeout: 1500 });
});

Then("a toast reports {string}", async ({ page }, text: string) => {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 60_000 });
});

Then("the worktree folder {string} is gone", async ({ project }, folder: string) => {
  await expect(async () => expect(existsSync(wtDir(project, folder))).toBe(false)).toPass({ timeout: 60_000 });
});

// Clean up fetches through the daemon, which refuses a remote folder outside the allowed roots: the origin sits beside the project.
Given("the scratch project is a git repository with an origin inside the allowed roots", async ({ project }) => {
  makeRepoWithOrigin(project.path, join(projectsRoot(runDir()), `${project.name}-origins`, "origin.git"));
});
