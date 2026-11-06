import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { makeRepoWithTwoCommits } from "../support/git-fixture.ts";
import { Given, Then, When } from "./fixtures.ts";

Given("the scratch project is a git repository with uncommitted files deep in single-child folders", async ({ project }) => {
  makeRepoWithTwoCommits(project.path);
  mkdirSync(join(project.path, "a/b/c/d"), { recursive: true });
  for (const f of ["a/b/c/d/x.ts", "a/b/c/d/y.ts", "z.md"]) writeFileSync(join(project.path, f), "new\n");
});

Then("the Changes list rows are {string}", async ({ page }, rows: string) => {
  const list = page.getByTestId("changes-panel").locator("ul[aria-label='Changed files'] button");
  // A file row ends in its A/D/R badge; only the name is compared.
  await expect(list).toHaveText(rows.split(", ").map((r) => new RegExp(`^${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ADR]?$`)), { timeout: 30_000 });
});

When("I switch the Changes list view", async ({ page }) => {
  await page.getByTestId("changes-list-view").click();
});
