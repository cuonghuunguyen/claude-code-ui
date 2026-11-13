import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { cssStr } from "../support/css.ts";
import { git, initRepo } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

const panel = (page: Page): Locator => page.getByTestId("find-in-files");
const match = (page: Page, path: string, line: number): Locator => page.locator(`[data-testid="find-match"][data-path="${cssStr(path)}"][data-line="${line}"]`);

Given("the scratch project has the replace files", async ({ project }) => {
  const put = (rel: string, body: string) => {
    mkdirSync(dirname(join(project.path, rel)), { recursive: true });
    writeFileSync(join(project.path, rel), body);
  };
  put("src/a.ts", "const x = user(1);\nconst y = user(2);\n");
  put("src/b.ts", "user(3)\r\nother\r\n");
  put("notes.md", "call user(4) here\n");
  initRepo(project.path);
  git(project.path, "add", "src", "notes.md");
  git(project.path, "commit", "-m", "initial");
});

When("I show the replace row in Find in files", async ({ page }) => {
  const toggle = page.getByTestId("find-replace-toggle");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await expect(page.getByTestId("find-replace")).toBeVisible();
});

When("I type the replacement {string} in Find in files", async ({ page }, text: string) => {
  await page.getByTestId("find-replace").fill(text);
});

Then("Find in files previews {int} new lines", async ({ page }, n: number) => {
  await expect(panel(page).getByTestId("find-after")).toHaveCount(n, { timeout: 15_000 });
});

Then("the preview of line {int} of {string} reads {string}", async ({ page }, line: number, path: string, text: string) => {
  await expect(match(page, path, line).getByTestId("find-after")).toHaveText(text, { timeout: 15_000 });
});

When("I uncheck the match on line {int} of {string} in Find in files", async ({ page }, line: number, path: string) => {
  await match(page, path, line).getByTestId("find-match-check").click();
  await expect(match(page, path, line)).toHaveAttribute("aria-checked", "false");
});

When("I click Replace all in Find in files", async ({ page }) => {
  const b = page.getByTestId("find-replace-all");
  await expect(b).toBeEnabled({ timeout: 15_000 });
  await b.click();
});

When("I click Undo in Find in files", async ({ page }) => {
  await page.getByTestId("find-undo").click();
});

Then("the Find in files summary says {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("find-summary")).toContainText(text, { timeout: 15_000 });
});

Then("the Find in files replace error is shown", async ({ page }) => {
  await expect(page.getByTestId("find-replace-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("find-replace-all")).toBeDisabled();
});

Then("the scratch file {string} is {string}", async ({ project }, rel: string, want: string) => {
  const text = readFileSync(join(project.path, rel), "utf8");
  expect(text).toBe(want.replace(/\\r/g, "\r").replace(/\\n/g, "\n"));
});
