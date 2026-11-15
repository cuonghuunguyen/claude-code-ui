import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { git, makeRepoWithOrigin } from "../support/git-fixture.ts";
import { runDir } from "../support/paths.ts";
import { sendPrompt } from "../support/flow.ts";
import { TURN_MS, toolCard as anyToolCard } from "../support/ui.ts";

/** The orchestration tool's own card, not the ToolSearch card that loaded it. */
const toolCard = (page: Page, tool: string): Locator => anyToolCard(page, tool).filter({ hasNotText: "ToolSearch" });
import { Given, Then, When } from "./fixtures.ts";

/** A worker row of the sidebar (the rows of a coordinator's workers may sit behind its "N workers" toggle). */
const workerRows = (page: Page): Locator => page.locator('[data-testid="session-item"][data-worker]');

// The daemon keeps the workers of earlier scenarios, and a worker group starts collapsed: open every collapsed group, not just the first.
async function revealWorkers(page: Page): Promise<void> {
  const collapsed = page.locator('[data-testid="worker-group-toggle"][aria-expanded="false"]');
  for (let n = await collapsed.count(); n > 0; n--) await collapsed.first().click();
}

// One daemon serves every scenario and keeps every scratch project, so the worktree name must be unique per scenario and retry (a shared name is ambiguous).
Given("the scratch project is a git repository with its own worktree", async ({ project, memo }) => {
  makeRepoWithOrigin(project.path, join(runDir(), "origins", `${project.name}.git`));
  const name = `wt-${createHash("sha1").update(project.name).digest("hex").slice(0, 8)}`;
  git(project.path, "worktree", "add", join(".claude", "worktrees", name), "-b", name);
  memo.worktree = name;
});

When("I enable orchestration in Settings", async ({ page }) => {
  await page.locator('[data-testid="open-settings"]:visible').first().click();
  await page.getByTestId("settings-group-orchestration").click();
  const toggle = page.getByTestId("settings-orchestration-enabled");
  if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
});

When("I send {string} with the scratch project and worktree names filled in", async ({ page, project, memo }, text: string) => {
  await sendPrompt(page, text.split("<project>").join(project.name).split("<worktree>").join(memo.worktree ?? ""));
});

Then("the {string} tool card is shown and finished", async ({ page }, text: string) => {
  await expect(toolCard(page, text).first()).toHaveAttribute("data-status", "done", { timeout: TURN_MS });
});

Then("the permission request names the scratch project", async ({ page, project }) => {
  await expect(page.getByTestId("permission-panel")).toContainText(project.name, { timeout: TURN_MS });
  await expect(page.getByTestId("permission-panel")).toContainText(/project/i);
});

Then("a worker session runs in the main checkout of the scratch project", async ({ page, project }) => {
  await expect(async () => {
    await revealWorkers(page);
    const titles = await workerRows(page).evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
    expect(titles.some((t) => t.split("\n").includes(project.path))).toBe(true);
  }).toPass({ timeout: 90_000 });
});
