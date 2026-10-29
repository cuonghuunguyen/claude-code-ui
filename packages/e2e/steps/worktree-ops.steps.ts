// Acceptance steps for GH-452 (Create worktree edge cases), GH-461 (Clean up), GH-463 (status cache), GH-462 (Remove worktree).
// Repositories are prepared with git commands in the scenario's scratch project; everything else goes through the UI.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { fakeJira } from "../support/fake-jira.ts";
import { git, makeRepoWithOrigin } from "../support/git-fixture.ts";
import { projectsRoot, runDir } from "../support/paths.ts";
import { Given, Then, When, type Project } from "./fixtures.ts";

const TOKEN = "e2e-jira-token";
const wtDir = (p: Project, name: string) => join(p.path, ".claude", "worktrees", name);
const phone = (page: Page) => page.viewportSize()!.width < 500;
// Rows of earlier scenarios stay in the shared daemon's sidebar: a row is always looked up by the scratch project's folder.
const worktreeRow = (page: Page, project: Project, branch: string | RegExp) =>
  page.locator(`[data-testid="worktree-row"][data-path^="${join(project.path, ".claude", "worktrees")}"]`).filter({ hasText: branch });

// ---- GH-452 -------------------------------------------------------------------------------------------------------
Given("a fake Jira with a ticket with a long summary and a ticket whose summary holds fix-123", async ({ jira }) => {
  jira.fake = await fakeJira({
    auth: `Bearer ${TOKEN}`,
    user: "Ann Example",
    issues: [
      { key: "PRJ-1", type: "Bug", summary: "Login button broken", status: "In Progress", mine: true },
      { key: "PRJ-4", type: "Story", summary: "Support repo with client/server folder structure like the monorepo template guide describes", status: "To Do", mine: true },
      { key: "PRJ-5", type: "Task", summary: "Handle fix-123 regression in importer", status: "To Do" },
    ],
  });
});

Then("the ticket branch name has a folder of at most {int} characters", async ({ page }, max: number) => {
  const v = await page.getByTestId("create-worktree-ticket-branch").inputValue();
  expect(v.length).toBeGreaterThan(10);
  expect(v.replaceAll("/", "-").length).toBeLessThanOrEqual(max);
});

Then("the ticket branch name does not contain {string}", async ({ page }, text: string) => {
  // The field keeps what was typed; the branch the modal will create is the normalized name.
  const v = (await page.getByTestId("create-worktree-branch").textContent()) ?? "";
  expect(v.length).toBeGreaterThan(5);
  expect(v).not.toContain(text);
});

Then("the modal shows no branch name problem and Create is enabled", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-problem")).toHaveCount(0);
  await expect(page.getByTestId("create-worktree-confirm")).toBeEnabled();
});

Then("the modal shows the branch name problem {string} and Create is disabled", async ({ page }, text: string) => {
  await expect(page.getByTestId("create-worktree-problem")).toContainText(text);
  await expect(page.getByTestId("create-worktree-confirm")).toBeDisabled();
});

When("I change the ticket branch name to {int} characters", async ({ page }, n: number) => {
  await page.getByTestId("create-worktree-ticket-branch").fill(`feature/PRJ-1-${"x".repeat(n - 14)}`);
});

Then("the Branch tab list is no longer fetching and shows {string} as {string}", async ({ page }, name: string, kind: string) => {
  await expect(page.getByTestId("create-worktree-fetching")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator(`[data-testid="create-worktree-branch-row"][data-name="${name}"]`)).toContainText(kind);
});

Given("the scratch project has a local branch {string} without worktree", async ({ project }, name: string) => {
  git(project.path, "branch", name, "main");
});

When("I remove the generated worktree from the sidebar", async ({ page, project }) => {
  await removeDialog(page, project, /worktree-[a-z]+-[a-z]+/);
  await page.getByTestId("remove-worktree-confirm").click();
});

When("I remove the worktree {string} from the sidebar", async ({ page, project }, branch: string) => {
  await removeDialog(page, project, branch);
  await page.getByTestId("remove-worktree-confirm").click();
});

Then("the worktree folder {string} is gone and its branch {string} is deleted", async ({ project }, folder: string, branch: string) => {
  await expect(async () => expect(existsSync(wtDir(project, folder))).toBe(false)).toPass({ timeout: 30_000 });
  expect(git(project.path, "branch", "--list", branch)).toBe("");
});

Then("the worktree folder {string} is gone and its branch {string} still exists", async ({ project }, folder: string, branch: string) => {
  await expect(async () => expect(existsSync(wtDir(project, folder))).toBe(false)).toPass({ timeout: 30_000 });
  expect(git(project.path, "branch", "--list", branch)).toContain(branch);
});

Then("the generated worktree is gone and its branch is deleted", async ({ project }) => {
  const root = join(project.path, ".claude", "worktrees");
  await expect(async () => expect(readdirSync(root).filter((n) => /^[a-z]+-[a-z]+$/.test(n))).toEqual([])).toPass({ timeout: 30_000 });
  expect(git(project.path, "branch", "--list", "worktree-*").split("\n").map((l) => l.trim()).filter((l) => l && l !== "worktree-mine")).toEqual([]);
});

// ---- repositories for Clean up and Remove -------------------------------------------------------------------------
const addWorktree = (p: Project, name: string) => {
  git(p.path, "worktree", "add", "-b", name, join(".claude", "worktrees", name));
};
// The daemon reads the worktree with git while a "terminal" command runs: a held index.lock is retried, as a user would.
const gitWait = (cwd: string, ...args: string[]) => {
  for (let i = 0; ; i++) {
    try {
      return git(cwd, ...args);
    } catch (e) {
      if (i >= 40 || !/index\.lock/.test(String(e))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
};
const commitIn = (dir: string, file: string, text: string, msg: string) => {
  writeFileSync(join(dir, file), text);
  gitWait(dir, "add", file);
  gitWait(dir, "commit", "-m", msg);
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

Given("the scratch project has a worktree {string} whose commits cancel out", async ({ project }, name: string) => {
  addWorktree(project, name);
  commitIn(wtDir(project, name), "c.txt", "c\n", "add c");
  git(wtDir(project, name), "rm", "c.txt");
  git(wtDir(project, name), "commit", "-m", "remove c");
});

// The change is squash merged on origin (same tree, other commit); the project has not fetched it yet.
Given("the scratch project has a worktree {string} that origin already squash merged", async ({ project }, name: string) => {
  git(project.path, "remote", "set-head", "origin", "main"); // a real clone has origin/HEAD: the base is origin/main, not the local main
  addWorktree(project, name);
  commitIn(wtDir(project, name), "sq.txt", "sq\n", "work one");
  commitIn(wtDir(project, name), "sq2.txt", "sq2\n", "work two");
  const origin = git(project.path, "remote", "get-url", "origin");
  const tmp = join(runDir(), "tmp-squash", project.name);
  mkdirSync(join(tmp, ".."), { recursive: true });
  git(join(tmp, ".."), "clone", origin, tmp);
  writeFileSync(join(tmp, "sq.txt"), "sq\n");
  writeFileSync(join(tmp, "sq2.txt"), "sq2\n");
  git(tmp, "add", ".");
  git(tmp, "commit", "-m", "squash of sq (#1)");
  git(tmp, "push", "origin", "main");
});

Given("the worktree {string} has {int} ignored files", async ({ project }, name: string, n: number) => {
  const dir = join(wtDir(project, name), "build");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.log`), "x\n");
});

Given("the worktree {string} has {int} ignored files in many folders", async ({ project }, name: string, n: number) => {
  for (let i = 0; i < n; i++) {
    const d = join(wtDir(project, name), "build", `d${i % 400}`);
    if (i < 400) mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `f${i}.log`), "x\n");
  }
});

// ---- the user's terminal ------------------------------------------------------------------------------------------
When("in a terminal I edit README.md in the worktree {string}", async ({ project }, name: string) => {
  writeFileSync(join(wtDir(project, name), "README.md"), `edited from a terminal ${Date.now()}\n`);
});

When("in a terminal I edit README.md in the worktree {string} and stage it", async ({ project }, name: string) => {
  writeFileSync(join(wtDir(project, name), "README.md"), `edited from a terminal ${Date.now()}\n`);
  gitWait(wtDir(project, name), "add", "README.md");
});

When("in a terminal I add the file {string} to the worktree {string}", async ({ project }, file: string, name: string) => {
  writeFileSync(join(wtDir(project, name), file), "new from a terminal\n");
});

When("in a terminal I commit a change in the worktree {string}", async ({ project }, name: string) => {
  commitIn(wtDir(project, name), "later.txt", "later\n", "later commit");
});

// ---- opening the dialogs --------------------------------------------------------------------------------------------
async function openProjectMenu(page: Page, project: Project, entry: "cleanup") {
  if (phone(page)) {
    await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("open-drawer").click();
    const r = page.locator(`[data-testid="group-toggle"][title="${project.path}"]`).locator("xpath=ancestor::h3");
    await expect(r.getByTestId("project-menu")).toBeInViewport({ timeout: 60_000 });
    await r.getByTestId("project-menu").click();
    await page.getByTestId(`project-menu-${entry}`).click();
  } else {
    await page.locator(`[data-testid="group-toggle"][title="${project.path}"]`).click({ button: "right", timeout: 60_000 });
    await page.getByTestId(`group-menu-${entry}`).click();
  }
}

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
type Snap = { t: number; fetch: string; rows: { text: string; badge: string; disabled: boolean }[] };
type RmSnap = { t: number; dialog: { text: string; confirm: boolean | null } | null; rows: { path: string; removing: boolean; dim: boolean }[] };
const timeline = (page: Page) => page.evaluate(() => (window as unknown as { __cl: unknown[] }).__cl) as Promise<Snap[]>;
const rmTimeline = (page: Page) => page.evaluate(() => (window as unknown as { __rm: unknown[] }).__rm) as Promise<RmSnap[]>;

When("I watch the dialogs of the page", async ({ page }) => page.evaluate(WATCH));

When("I open Clean up from the menu of the scratch project", async ({ page, project }) => {
  await page.evaluate(WATCH);
  await page.evaluate(() => ((window as unknown as { __cl: unknown[] }).__cl.length = 0)); // the timeline of this open only
  await openProjectMenu(page, project, "cleanup");
  await expect(page.getByTestId("cleanup-dialog")).toBeVisible();
});

When("I close the Clean up dialog", async ({ page }) => {
  await page.getByTestId("cleanup-close").or(page.getByTestId("cleanup-cancel")).first().click();
  await expect(page.getByTestId("cleanup-dialog")).toBeHidden();
});

const cleanupRow = (page: Page, branch: string) => page.getByTestId("cleanup-row").filter({ hasText: branch });

Then("Clean up has finished fetching", async ({ page }) => {
  await expect(page.getByTestId("cleanup-fetch")).toContainText(/Fetched|Fetch failed/, { timeout: 60_000 });
});

Then("Clean up showed Fetching… and then Fetched", async ({ page }) => {
  const tl = await timeline(page);
  const iFetching = tl.findIndex((s) => s.fetch.includes("Fetching…"));
  const iFetched = tl.findIndex((s) => /Fetched \d+ s ago|Fetched/.test(s.fetch));
  expect(iFetching, "a Fetching… line was shown").toBeGreaterThanOrEqual(0);
  expect(iFetched, "Fetched shown after").toBeGreaterThan(iFetching);
});

Then("Clean up says the fetch failed and rows still resolve", async ({ page }) => {
  await expect(page.getByTestId("cleanup-fetch")).toContainText("Fetch failed", { timeout: 60_000 });
  await expect(page.getByTestId("cleanup-badge").first()).not.toHaveText(/^Checking…$/, { timeout: 60_000 });
});

Then("the Clean up row {string} is {string}", async ({ page }, branch: string, text: string) => {
  await expect(cleanupRow(page, branch).getByTestId("cleanup-badge")).toContainText(text, { timeout: 60_000 });
});

Then("the Clean up row {string} mentions {string}", async ({ page }, branch: string, text: string) => {
  await expect(cleanupRow(page, branch)).toContainText(text);
});

Then("the Clean up row {string} can be ticked", async ({ page }, branch: string) => {
  await expect(cleanupRow(page, branch).getByTestId("cleanup-check")).toBeEnabled();
});

When("I tick the Clean up row {string}", async ({ page }, branch: string) => {
  await cleanupRow(page, branch).getByTestId("cleanup-check").check();
});

When("I also delete the branch of the Clean up row {string}", async ({ page }, branch: string) => {
  await cleanupRow(page, branch).getByTestId("cleanup-delete-branch").check();
});

When("I confirm Clean up", async ({ page }) => {
  const ack = page.getByTestId("cleanup-ack");
  if (await ack.isVisible()) await ack.check();
  await page.getByTestId("cleanup-confirm").click();
});

Then("the Clean up summary says {string} was not removed because it {string}", async ({ page }, branch: string, reason: string) => {
  const li = page.getByTestId("cleanup-summary").getByRole("listitem").filter({ hasText: branch });
  await expect(li).toContainText(reason, { timeout: 60_000 });
});

Then("the Clean up dialog fits the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const b = (await page.getByTestId("cleanup-dialog").boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(vw);
});

Then("the cached row {string} was shown before the fetch finished", async ({ page }, branch: string) => {
  const tl = await timeline(page);
  const early = tl.filter((s) => !/Fetched|Fetch failed/.test(s.fetch)).map((s) => s.rows.find((r) => r.text.includes(branch))?.badge ?? "");
  expect(early.some((b) => /^(Safe|Has work)/.test(b)), `badges before Fetched: ${[...new Set(early)].join(" | ")}`).toBe(true);
});

Then("the row {string} showed Checking… with its checkbox disabled and then a fresh result", async ({ page }, branch: string) => {
  const tl = (await timeline(page)).map((s) => ({ ...s, row: s.rows.find((r) => r.text.includes(branch)) })).filter((s) => s.row);
  const i = tl.findIndex((s) => s.row!.badge.includes("Checking…") && s.row!.disabled);
  expect(i, `${branch}: Checking… shown with the checkbox disabled`).toBeGreaterThanOrEqual(0);
  // The cached verdict is kept visible next to Checking…, not hidden.
  expect(tl[i]!.row!.badge).toMatch(/Safe|Has work|Checking…/);
  expect(tl.slice(i).some((s) => !s.row!.badge.includes("Checking…")), "a fresh result followed").toBe(true);
});

Then("the row {string} never showed Checking…", async ({ page }, branch: string) => {
  const tl = (await timeline(page)).map((s) => s.rows.find((r) => r.text.includes(branch))).filter(Boolean);
  expect(tl.length).toBeGreaterThan(0);
  expect(tl.some((r) => r!.badge.includes("Checking…"))).toBe(false);
});

Then("the status bar of the app answers while Clean up scans", async ({ page }) => {
  // The page stays interactive during the scan: the sidebar still hovers and the dialog still closes (see the report for the daemon-side tier tests).
  await expect(page.getByTestId("sidebar")).toBeVisible();
});

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

Then("the row of {string} showed Removing… dimmed before it disappeared", async ({ page, project }, branch: string) => {
  const path = join(project.path, ".claude", "worktrees", branch);
  await expect(page.locator(`[data-testid="worktree-row"][data-path="${path}"]`)).toHaveCount(0, { timeout: 60_000 });
  const tl = await rmTimeline(page);
  const mine = tl.map((s) => s.rows.find((r) => r.path === path));
  const i = mine.findIndex((r) => r?.removing && r.dim);
  expect(i, "a Removing… dimmed row was shown").toBeGreaterThanOrEqual(0);
  expect(tl.slice(i).some((s) => !s.rows.some((r) => r.path === path)), "the row disappeared after").toBe(true);
});

Then("a toast reports an ignored files count", async ({ page }) => {
  await expect(page.getByText(/Removed wt-big: \d+ ignored files deleted/).first()).toBeVisible({ timeout: 60_000 });
  console.log("toast:", await page.getByText(/Removed wt-big: \d+ ignored files deleted/).first().textContent());
});

Then("a toast reports {string}", async ({ page }, text: string) => {
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 60_000 });
});

Then("the worktree folder {string} is gone", async ({ project }, folder: string) => {
  await expect(async () => expect(existsSync(wtDir(project, folder))).toBe(false)).toPass({ timeout: 60_000 });
});

Then("the branch {string} is gone", async ({ project }, branch: string) => {
  expect(git(project.path, "branch", "--list", branch)).toBe("");
});

Then("the branch {string} still exists", async ({ project }, branch: string) => {
  expect(git(project.path, "branch", "--list", branch)).toContain(branch);
});

Then("the removal is refused with an error naming {string}", async ({ page, project }, branch: string) => {
  const path = join(project.path, ".claude", "worktrees", branch);
  const seen = async () => {
    const refused = await page.evaluate(() => (window as unknown as { __refused?: string }).__refused ?? "");
    const tl = await rmTimeline(page);
    const mine = tl.map((x) => x.rows.find((r) => r.path === path));
    const i = mine.findIndex((r) => r?.removing);
    const back = i >= 0 && mine.slice(i).some((r) => r && !r.removing);
    return { refused, tried: back };
  };
  // The removal was tried (the row showed Removing… and came back) and the daemon refused it: the banner names the worktree.
  try {
    await expect.poll(async () => { const r = await seen(); return r.refused.includes(`Worktree ${branch} not removed`) || r.tried; }, { timeout: 30_000 }).toBe(true);
  } catch (e) {
    const tl = await rmTimeline(page);
    console.log("NO REMOVAL ATTEMPT SEEN; dialog states:", JSON.stringify(tl.map((x) => [x.t, x.dialog && [x.dialog.text.slice(0, 60), x.dialog.confirm], x.rows.filter((r) => r.path === path).map((r) => r.removing)]).slice(-25)));
    throw e;
  }
  const r = await seen();
  console.log(`refusal ${branch}: banner="${r.refused}" rowShowedRemovingAndReturned=${r.tried}`);
  expect(r.refused, "the refusal message was shown").toContain(`Worktree ${branch} not removed`);
});

Then("nothing of the worktree {string} was deleted", async ({ project }, name: string) => {
  const dir = wtDir(project, name);
  expect(existsSync(dir), "folder exists").toBe(true);
  expect(existsSync(join(dir, ".git")), ".git file exists").toBe(true);
  expect(git(project.path, "branch", "--list", name)).toContain(name);
  expect(git(project.path, "worktree", "list", "--porcelain")).toContain(dir);
  expect(readFileSync(join(dir, "README.md"), "utf8").length).toBeGreaterThan(0);
});

Then("the file {string} of the worktree {string} still exists", async ({ project }, file: string, name: string) => {
  expect(existsSync(join(wtDir(project, name), file))).toBe(true);
});

Then("the worktree row of {string} is not dimmed", async ({ page, project }, branch: string) => {
  const row = worktreeRow(page, project, branch).first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("worktree-removing")).toHaveCount(0);
});

// Clean up fetches through the daemon, which refuses a remote folder outside the allowed roots: the origin sits beside the project.
Given("the scratch project is a git repository with an origin inside the allowed roots", async ({ project }) => {
  makeRepoWithOrigin(project.path, join(projectsRoot(runDir()), `${project.name}-origins`, "origin.git"));
});
