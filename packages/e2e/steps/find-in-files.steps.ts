import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { git, initRepo } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";
import { cssStr } from "../support/css.ts";

const panel = (page: Page): Locator => page.getByTestId("find-in-files");
const query = (page: Page): Locator => page.getByTestId("find-query");
const editor = (page: Page): Locator => page.getByTestId("files-panel").locator(".cm-content").first();

Given("the scratch project has the search files", async ({ project }) => {
  const put = (rel: string, body: string | Buffer) => {
    mkdirSync(dirname(join(project.path, rel)), { recursive: true });
    writeFileSync(join(project.path, rel), body);
  };
  const lines = Array.from({ length: 15 }, (_, i) => `const l${i + 1} = ${i + 1};`);
  lines[9] = "const needle = foo1;";
  put("src/a.ts", lines.join("\n") + "\n");
  put("src/b.md", "needle in the notes\n");
  put("bin.dat", Buffer.from("\0needle\n"));
  put(".gitignore", "dist/\n");
  put("dist/out.js", "needle\n");
});

Given("the scratch project is a git repository", async ({ project }) => {
  initRepo(project.path);
  git(project.path, "add", ".gitignore", "src");
  git(project.path, "commit", "-m", "initial");
});

Then("the Find in files panel is open", async ({ page }) => {
  await expect(panel(page)).toBeVisible();
  await expect(query(page)).toBeFocused();
});

When("I search files for {string}", async ({ page }, text: string) => {
  await query(page).fill(text);
});

When("I turn on regular expressions in Find in files", async ({ page }) => {
  await page.getByTestId("find-regex").click();
  await expect(page.getByTestId("find-regex")).toHaveAttribute("aria-pressed", "true");
});

When("I limit Find in files to the files {string}", async ({ page }, globs: string) => {
  await page.getByTestId("find-globs").fill(globs);
});

When("I click Include ignored files in Find in files", async ({ page }) => {
  await page.getByTestId("find-ignored").click();
});

Then("Find in files lists the file {string}", async ({ page }, path: string) => {
  await expect(page.locator(`[data-testid="find-file"][data-path="${cssStr(path)}"]`)).toBeVisible({ timeout: 15_000 });
});

Then("Find in files does not list the file {string}", async ({ page }, path: string) => {
  await expect(page.locator(`[data-testid="find-file"][data-path="${cssStr(path)}"]`)).toHaveCount(0);
});

Then("Find in files lists only the files {string}", async ({ page }, paths: string) => {
  const want = paths.split(",");
  await expect(page.getByTestId("find-file")).toHaveCount(want.length, { timeout: 15_000 });
  for (const p of want) await expect(page.locator(`[data-testid="find-file"][data-path="${cssStr(p)}"]`)).toBeVisible();
});

Then("Find in files marks the hits and shows the lines around line {int} of {string}", async ({ page }, line: number, path: string) => {
  const match = page.locator(`[data-testid="find-match"][data-path="${cssStr(path)}"][data-line="${line}"]`);
  await expect(match).toBeVisible({ timeout: 15_000 });
  await expect(match.locator("mark").first()).toBeVisible();
  // Two context lines before and after: the gutter shows their numbers.
  const results = page.getByTestId("find-results");
  for (const n of [line - 2, line - 1, line + 1, line + 2]) await expect(results.getByText(String(n), { exact: true }).first()).toBeVisible();
});

Then("Find in files marks {string} on line {int} of {string}", async ({ page }, hit: string, line: number, path: string) => {
  const match = page.locator(`[data-testid="find-match"][data-path="${cssStr(path)}"][data-line="${line}"]`);
  await expect(match.locator("mark").first()).toHaveText(hit, { timeout: 15_000 });
});

Then("Include ignored files is {word} in Find in files", async ({ page }, state: string) => {
  await expect(page.getByTestId("find-ignored")).toHaveAttribute("aria-pressed", state === "on" ? "true" : "false", { timeout: 15_000 });
});

Then("Find in files shows no alert", async ({ page }) => {
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
});

Then("the Find in files query is {string} and its file filter is {string}", async ({ page }, q: string, globs: string) => {
  await expect(query(page)).toHaveValue(q);
  await expect(page.getByTestId("find-globs")).toHaveValue(globs);
});

Then("the Find in files panel is closed", async ({ page }) => {
  await expect(panel(page)).toHaveCount(0);
});

When("I select {string} on the Files editor line with {string}", async ({ page }, word: string, lineText: string) => {
  const line = editor(page).locator(".cm-line").filter({ hasText: lineText }).first();
  await line.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < lineText.indexOf(word); i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  for (let i = 1; i < word.length; i++) await page.keyboard.press("Shift+ArrowRight");
});

When("I select two lines of the Files editor", async ({ page }) => {
  await editor(page).locator(".cm-line").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
});
