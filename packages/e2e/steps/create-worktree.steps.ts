import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { fakeJira } from "../support/fake-jira.ts";
import { git, makeRepoWithOrigin } from "../support/git-fixture.ts";
import { sendPrompt } from "../support/flow.ts";
import { daemonConfigDir, runDir } from "../support/paths.ts";
import { Given, Then, When } from "./fixtures.ts";

const modal = (page: Page) => page.getByTestId("create-worktree");
const row = (page: Page, path: string) => page.locator(`[data-testid="group-toggle"][title="${path}"]`).locator("xpath=ancestor::h3");
const worktreeDir = (project: string, folder: string) => join(project, ".claude", "worktrees", folder);
const TOKEN = "e2e-jira-token";

// The Settings button of the sidebar (a drawer on a phone); Control+, is not the shortcut on macOS.
async function openJiraSettings(page: Page) {
  const drawer = page.getByTestId("open-drawer");
  const settings = page.getByTestId("open-settings").last(); // the drawer copy on a phone
  if (await drawer.isVisible()) {
    // The drawer slides in: click Settings inside the retry so a click during the slide is repeated; open the drawer only when it is shut.
    await expect(async () => {
      const shut = await expect(settings).toBeInViewport({ timeout: 300 }).then(() => false, () => true);
      if (shut) await drawer.click();
      await settings.click({ timeout: 2000 });
    }).toPass({ timeout: 20_000 });
  } else await settings.click();
  await page.getByTestId("settings-group-jira").click();
}

Given("the scratch project is a git repository with an origin", async ({ project }) => {
  makeRepoWithOrigin(project.path, join(runDir(), "origins", `${project.name}.git`));
});

Given("the origin of the scratch project is unreachable", async ({ project }) => {
  git(project.path, "remote", "set-url", "origin", join(runDir(), "origins", "missing.git"));
});

Given("a fake Jira with my tickets PRJ-1 and PRJ-2 and another ticket PRJ-3", async ({ jira }) => {
  jira.fake = await fakeJira({
    auth: `Bearer ${TOKEN}`,
    user: "Ann Example",
    issues: [
      { key: "PRJ-1", type: "Bug", summary: "Login button broken", status: "In Progress", mine: true },
      { key: "PRJ-2", type: "Story", summary: "Revisit the old try", status: "To Do", mine: true },
      { key: "PRJ-3", type: "Task", summary: "Search indexing slow", status: "To Do" },
    ],
  });
});

When("I set up Jira in Settings with the fake Jira", async ({ page, jira }) => {
  await openJiraSettings(page);
  const url = page.getByTestId("settings-jira-url");
  await expect(url).toBeVisible();
  // A token of an earlier scenario (the daemon is shared) is cleared by the save of this new origin: wait for that.
  const stale = await page.getByTestId("settings-jira-token-set").isVisible();
  await url.fill(jira.fake!.url);
  await url.press("Enter");
  if (stale) await expect(page.getByTestId("settings-jira-token-set")).toHaveCount(0);
  const replace = page.getByTestId("settings-jira-token-replace");
  if (await replace.isVisible()) await replace.click();
  await page.getByTestId("settings-jira-token").fill(TOKEN);
  await page.getByTestId("settings-jira-token-save").click();
  await expect(page.getByTestId("settings-jira-token-set")).toHaveText(/Token set/);
  await page.getByTestId("settings-jira-test").click();
});

Then("Jira reports it is connected as {string}", async ({ page }, user: string) => {
  await expect(page.getByTestId("settings-jira-test-result")).toHaveText(`Connected as ${user}`);
});

When("I close Settings", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

When("I click the new worktree button of the scratch project", async ({ page, project }) => {
  const r = row(page, project.path);
  await r.hover();
  await r.getByTestId("project-new-worktree").click({ timeout: 60_000 });
});

When("I shift-click the new worktree button of the scratch project", async ({ page, project }) => {
  const r = row(page, project.path);
  await r.hover();
  await r.getByTestId("project-new-worktree").click({ modifiers: ["Shift"], timeout: 60_000 });
});

When("I choose {string} in the menu of the scratch project", async ({ page, project }, entry: string) => {
  // The phone's sidebar is a drawer: open it, then wait for the project row (the project list refreshes after Open project).
  // Opening a project ends in a new-session tab that closes the drawer: wait for it first.
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("open-drawer")).toBeVisible();
  await page.getByTestId("open-drawer").click();
  const r = row(page, project.path);
  await expect(r.getByTestId("project-menu")).toBeInViewport({ timeout: 60_000 });
  await r.getByTestId("project-menu").click();
  await page.getByTestId(`project-menu-${entry}`).click();
});

Then("the Create worktree modal is open", async ({ page }) => {
  await expect(modal(page)).toBeVisible();
});

Then("no Create worktree modal is open", async ({ page }) => {
  await expect(modal(page)).toBeHidden();
});

When("I open the {string} tab of the modal", async ({ page }, tab: string) => {
  await page.getByTestId(`create-worktree-tab-${tab}`).click();
});

When("I type the worktree name {string}", async ({ page }, name: string) => {
  await page.getByTestId("create-worktree-name").fill(name);
});

Then("the modal shows branch {string} in folder {string}", async ({ page }, branch: string, folder: string) => {
  await expect(page.getByTestId("create-worktree-branch")).toHaveText(branch);
  await expect(page.getByTestId("create-worktree-folder")).toHaveText(folder);
});

When("I choose the base {string}", async ({ page }, ref: string) => {
  await page.getByTestId("create-worktree-base").click();
  await page.getByTestId(`create-worktree-base-${ref || "default"}`).click();
});

When("I confirm the modal", async ({ page }) => {
  await page.getByTestId("create-worktree-confirm").click();
});

Then("the modal closes", async ({ page }) => {
  await expect(modal(page)).toBeHidden({ timeout: 60_000 });
});

Then("the new-session tab runs in the worktree {string}", async ({ page }, branch: string) => {
  await expect(page.getByTestId("new-session-tab")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("worktree-chip")).toContainText(branch, { timeout: 60_000 });
});

Then("the worktree folder {string} is on branch {string}", async ({ project }, folder: string, branch: string) => {
  const dir = worktreeDir(project.path, folder);
  expect(existsSync(dir), `${dir} exists`).toBe(true);
  expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
});

Then("the worktree folder {string} has the same commit as {string}", async ({ project }, folder: string, ref: string) => {
  const head = git(worktreeDir(project.path, folder), "rev-parse", "HEAD");
  expect(head).toBe(git(project.path, "rev-parse", ref));
  expect(head, "not the default base").not.toBe(git(project.path, "rev-parse", "refs/heads/main"));
});

Then("the branch {string} of the worktree folder {string} tracks {string}", async ({ project }, branch: string, folder: string, upstream: string) => {
  expect(git(worktreeDir(project.path, folder), "rev-parse", "--abbrev-ref", `${branch}@{upstream}`)).toBe(upstream);
});

Then("the main branch row is disabled", async ({ page }) => {
  const r = page.locator('[data-testid="create-worktree-branch-row"][data-name="main"]');
  await expect(r).toHaveAttribute("aria-disabled", "true");
  await expect(r).toContainText(/in worktree/);
});

Then("the branch list shows {string} as {string}", async ({ page }, name: string, kind: string) => {
  const r = page.locator(`[data-testid="create-worktree-branch-row"][data-name="${name}"]`);
  await expect(r).toContainText(kind);
  await expect(r).toHaveAttribute("aria-disabled", "false");
});

Then("the modal says origin could not be fetched", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-offline")).toBeVisible({ timeout: 60_000 });
});

When("I pick the branch row {string}", async ({ page }, name: string) => {
  await page.locator(`[data-testid="create-worktree-branch-row"][data-name="${name}"]`).click();
});

Then("the Check out button is shown", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-confirm")).toHaveText(/Check out/);
});

Then("the ticket rows are {string}", async ({ page }, keys: string) => {
  const want = keys.split(",").map((k) => k.trim());
  await expect(async () => {
    const got = await page.getByTestId("create-worktree-ticket-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-key")));
    expect(got.sort()).toEqual([...want].sort());
  }).toPass({ timeout: 15_000 });
});

When("I search tickets for {string}", async ({ page }, text: string) => {
  await page.getByTestId("create-worktree-ticket-search").fill(text);
});

When("I search tickets for the Jira URL of {string}", async ({ page, jira }, key: string) => {
  await page.getByTestId("create-worktree-ticket-search").fill(`${jira.fake!.url}/browse/${key}`);
});

When("I pick the ticket {string}", async ({ page }, key: string) => {
  await page.locator(`[data-testid="create-worktree-ticket-row"][data-key="${key}"]`).click();
});

Then("the ticket branch name starts with {string}", async ({ page }, prefix: string) => {
  await expect(page.getByTestId("create-worktree-ticket-branch")).toHaveValue(new RegExp(`^${prefix}`));
});

When("I change the ticket branch name to {string}", async ({ page }, name: string) => {
  await page.getByTestId("create-worktree-ticket-branch").fill(name);
});

Then("the modal offers to check out the existing branch {string}", async ({ page }, branch: string) => {
  await expect(page.getByTestId("create-worktree-existing")).toContainText(branch);
});

When("I check out the existing branch", async ({ page }) => {
  await page.getByTestId("create-worktree-checkout-existing").click();
});

Then("a worktree with a generated name exists", async ({ project }) => {
  const dir = join(project.path, ".claude", "worktrees");
  await expect(async () => {
    const names = existsSync(dir) ? readdirSync(dir) : [];
    expect(names.length).toBe(1);
    expect(names[0]).toMatch(/^[a-z]+-[a-z]+$/);
    expect(git(join(dir, names[0]!), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`worktree-${names[0]}`);
  }).toPass({ timeout: 30_000 });
});

Then("the new-session tab runs in a worktree with a generated name", async ({ page }) => {
  await expect(page.getByTestId("worktree-chip")).toContainText(/worktree-[a-z]+-[a-z]+/, { timeout: 60_000 });
});

Then("the modal fits the viewport", async ({ page }) => {
  const vw = page.viewportSize()!.width;
  const b = (await modal(page).boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vw);
  const m = await page.evaluate(() => ({ inner: window.innerWidth, root: document.documentElement.scrollWidth }));
  expect(m.root).toBe(m.inner);
});

// .worktreeinclude: `.env` and `config/local.env` are ignored and listed (copied); `skip.log` is ignored but not listed;
// `tracked.env` is ignored, listed, and committed with -f, then edited in the main checkout (tracked: never copied).
Given("the scratch project has gitignored files listed in .worktreeinclude", async ({ project, memo }) => {
  const dir = project.path;
  writeFileSync(join(dir, ".gitignore"), ".env\nconfig/local.env\nskip.log\ntracked.env\n.claude/\n");
  writeFileSync(join(dir, ".worktreeinclude"), "# secrets the worktree needs\n.env\nconfig/local.env\ntracked.env\n");
  writeFileSync(join(dir, "tracked.env"), "committed\n");
  git(dir, "add", ".gitignore", ".worktreeinclude");
  git(dir, "add", "-f", "tracked.env");
  git(dir, "commit", "-m", "worktreeinclude fixture");
  git(dir, "push", "origin", "main"); // a new worktree branches from origin/main, so the fixture commit must be there
  memo.envValue = `secret-${randomUUID()}`;
  writeFileSync(join(dir, "tracked.env"), "edited in the main checkout\n");
  writeFileSync(join(dir, ".env"), `${memo.envValue}\n`);
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(join(dir, "config", "local.env"), `local-${memo.envValue}\n`);
  writeFileSync(join(dir, "skip.log"), "not listed\n");
});

// Claude Code's rule for a wholly ignored folder: `node_modules/` (ignored, no pattern names it) is not searched for `**/config.json`;
// `vendor/` (ignored, named by a pattern) is copied with its files; `config/` (ignored) gets only `config/secrets.json`, a pattern with a path.
Given("the scratch project has an ignored node_modules and an ignored vendor folder with a .worktreeinclude of config.json files", async ({ project, memo }) => {
  const dir = project.path;
  writeFileSync(join(dir, ".gitignore"), "node_modules/\nvendor/\nconfig/\n.claude/\n");
  writeFileSync(join(dir, ".worktreeinclude"), "**/config.json\nvendor/\nconfig/secrets.json\n");
  git(dir, "add", ".gitignore", ".worktreeinclude");
  git(dir, "commit", "-m", "worktreeinclude folder fixture");
  memo.envValue = `secret-${randomUUID()}`;
  for (const f of ["node_modules/pkg/config.json", "vendor/lib/config.json", "vendor/data.txt", "config/secrets.json", "config/other.txt"]) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), `${memo.envValue}\n`);
  }
});

Then("the worktree folder {string} has {string} with the main checkout's content", async ({ project, memo }, folder: string, file: string) => {
  const dst = join(worktreeDir(project.path, folder), file);
  await expect(async () => expect(existsSync(dst), `${dst} exists`).toBe(true)).toPass({ timeout: 60_000 });
  expect(readFileSync(dst, "utf8")).toBe(readFileSync(join(project.path, file), "utf8"));
  expect(readFileSync(dst, "utf8")).toContain(memo.envValue!);
});

Then("the worktree folder {string} has no {string}", async ({ project }, folder: string, file: string) => {
  expect(existsSync(worktreeDir(project.path, folder)), "worktree exists").toBe(true);
  expect(existsSync(join(worktreeDir(project.path, folder), file)), `${file} absent`).toBe(false);
});

Then("the worktree folder {string} keeps the committed content of {string}", async ({ project }, folder: string, file: string) => {
  const dst = join(worktreeDir(project.path, folder), file);
  expect(readFileSync(dst, "utf8")).toBe("committed\n");
  expect(git(worktreeDir(project.path, folder), "status", "--porcelain", "--", file)).toBe("");
});

When("I send {string} with the scratch project and a new branch name filled in", async ({ page, project, memo }, text: string) => {
  memo.branch = `wi-env-${createHash("sha1").update(project.name).digest("hex").slice(0, 8)}`;
  await sendPrompt(page, text.split("<project>").join(project.name).split("<branch>").join(memo.branch));
});

Then("the worktree folder of the new branch has {string} with the main checkout's content", async ({ project, memo }, file: string) => {
  const dst = join(worktreeDir(project.path, memo.branch!), file);
  await expect(async () => expect(existsSync(dst), `${dst} exists`).toBe(true)).toPass({ timeout: 90_000 });
  expect(readFileSync(dst, "utf8")).toBe(readFileSync(join(project.path, file), "utf8"));
});

Then("the worktree folder of the new branch has no {string}", async ({ project, memo }, file: string) => {
  expect(existsSync(join(worktreeDir(project.path, memo.branch!), file)), `${file} absent`).toBe(false);
});

Then("the generated worktree has {string} with the main checkout's content", async ({ project }, file: string) => {
  const root = join(project.path, ".claude", "worktrees");
  await expect(async () => {
    const dst = join(root, readdirSync(root)[0]!, file);
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf8")).toBe(readFileSync(join(project.path, file), "utf8"));
  }).toPass({ timeout: 30_000 });
});

// Settings › Jira URL and token (GH-451)
const urlField = (page: Page) => page.getByTestId("settings-jira-url");

When("I open Settings › Jira", async ({ page }) => openJiraSettings(page));

const setUrl = async (page: Page, value: string) => {
  const f = urlField(page);
  await f.fill(value);
  await f.press("Enter");
  await expect(f).toBeEnabled(); // the save finished
};

When("I set the Jira URL to {string}", async ({ page }, value: string) => setUrl(page, value));
When("I set the Jira URL to the fake Jira", async ({ page, jira }) => setUrl(page, jira.fake!.url));
When("I set the Jira URL to the fake Jira on another host", async ({ page, jira }) => setUrl(page, jira.fake!.url.replace("127.0.0.1", "localhost")));
When("I set the Jira URL to the fake Jira with the path {string}", async ({ page, jira }, path: string) => setUrl(page, jira.fake!.url + path));

Then("the Jira URL shows an https error", async ({ page }) => {
  const err = page.getByTestId("settings-dialog").getByTestId("banner-error");
  await expect(err).toContainText(/https/i);
  await expect(urlField(page)).not.toHaveValue(/^http:\/\/jira\.example\.com/); // refused: the field shows the old value
});

Then("the Jira URL shows no error", async ({ page }) => {
  await expect(page.getByTestId("settings-dialog").getByTestId("banner-error")).toHaveCount(0);
  await expect(page.getByTestId("settings-jira-url-error")).toHaveCount(0);
  await expect(urlField(page)).not.toHaveValue(""); // accepted: the field keeps the address
});

Then("the Jira token is not set", async ({ page }) => {
  await expect(page.getByTestId("settings-jira-token-set")).toHaveCount(0);
  await expect(page.getByTestId("settings-jira-token")).toBeVisible();
});

Then("the Jira token is set", async ({ page }) => {
  await expect(page.getByTestId("settings-jira-token-set")).toHaveText(/Token set/);
});

Then("the Ticket tab asks to set up Jira", async ({ page }) => {
  await expect(page.getByTestId("create-worktree-no-jira")).toBeVisible();
  await expect(page.getByTestId("create-worktree-ticket-row")).toHaveCount(0);
});

// GH-487: a token of the old format (no host saved next to it) is dropped; Settings says why.
Given("the daemon's saved Jira token has the old format without a host", async () => {
  writeFileSync(join(daemonConfigDir(runDir()), "secrets.json"), JSON.stringify({ jiraToken: TOKEN }), { mode: 0o600 });
});

Then("Settings › Jira says the saved token was cleared by a security update", async ({ page }) => {
  await expect(page.getByTestId("settings-jira-token-reset")).toBeVisible();
  await expect(page.getByTestId("settings-jira-token-reset")).toHaveText("Your saved token was cleared by a security update. Enter it again.");
});

When("I save the Jira token {string}", async ({ page }, value: string) => {
  await page.getByTestId("settings-jira-token").fill(value);
  await page.getByTestId("settings-jira-token-save").click();
});

Then("Settings › Jira shows no token reset notice", async ({ page }) => {
  await expect(page.getByTestId("settings-jira-token-reset")).toHaveCount(0);
});
