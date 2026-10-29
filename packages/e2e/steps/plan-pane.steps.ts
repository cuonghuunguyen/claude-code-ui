import { expect, type Locator, type Page } from "@playwright/test";
import { openApp, openProject, prepareHaikuSession, REPLY_PROMPT, sendPrompt } from "../support/flow.ts";
import { TURN_MS } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

const PLAN_PROMPT = "Plan only. Call ExitPlanMode right now with its plan parameter set to a two-step markdown list: create hello.txt containing hi, verify it. Do not write any file and use no other tool.";
const side = (page: Page) => page.getByTestId("side-panel");
const planTabs = (page: Page) => page.locator('[data-testid="tab"][data-tab-id^="plan:"]');
const sessionTabs = (page: Page) => page.locator('[data-testid="tab"]:not([data-tab-id^="plan:"]):not([data-tab-id=""])').filter({ has: page.locator('[role="tab"]') });
const planTab = (page: Page) => planTabs(page).first();
const planTabButton = (page: Page) => planTab(page).locator('[role="tab"]');
const toast = (page: Page) => page.getByTestId("toast");

async function chooseMode(page: Page, label: string): Promise<void> {
  const settings = page.getByTestId("session-settings");
  const phone = await settings.isVisible();
  if (phone) await settings.click();
  await page.getByTestId("mode-select").click();
  await page.getByRole("option", { name: label }).click();
  if (phone) await page.keyboard.press("Escape");
}

/** Index of each tab in the strip, by data-tab-id. */
async function stripIds(page: Page): Promise<string[]> {
  return page.locator('[data-testid="tab-strip"] [data-testid="tab"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-tab-id") ?? ""));
}

async function menuOf(loc: Locator): Promise<void> {
  await loc.click({ button: "right" });
}

Given("a Haiku session in Plan mode with a plan waiting for approval", async ({ page, daemon, project }) => {
  await openApp(page, daemon);
  await openProject(page, project.path);
  await prepareHaikuSession(page, project.name);
  await chooseMode(page, "Plan mode");
  await sendPrompt(page, PLAN_PROMPT);
  await expect(page.getByTestId("permission-panel")).toBeVisible({ timeout: TURN_MS });
  await expect(side(page).getByTestId("pane-plan")).toBeVisible();
});

When("I switch the session to Plan mode", async ({ page }) => {
  await chooseMode(page, "Plan mode");
});

Then("the side panel has no Plan tab", async ({ page }) => {
  await expect(side(page)).toBeVisible();
  await expect(side(page).getByTestId("pane-plan")).toHaveCount(0);
});

Then("the side panel lists the Plan tab after Git graph", async ({ page }) => {
  const names = await side(page).locator("[data-pane-tab]").evaluateAll((els) => els.map((e) => e.getAttribute("data-pane-tab")));
  expect(names).toContain("plan");
  expect(names.indexOf("plan")).toBeGreaterThan(names.indexOf("graph"));
});

Then("the Plan pane shows the plan as markdown", async ({ page }) => {
  await side(page).getByTestId("pane-plan").click();
  const pane = page.getByTestId("plan-pane");
  await expect(pane).toBeVisible();
  await expect(pane).toHaveText(/\S/);
  // Structure: rendered markdown (a list, heading or paragraph element), not a raw text node.
  await expect(pane.locator("p, ol, ul, h1, h2, h3, li").first()).toBeVisible();
});

Then("the Plan pane waits for my answer", async ({ page }) => {
  await expect(page.getByTestId("plan-waiting")).toContainText("Waiting for your answer");
  await expect(page.getByTestId("plan-go-to-request")).toBeVisible();
});

When("I click Go to request in the Plan pane", async ({ page }) => {
  await side(page).getByTestId("pane-plan").click();
  await page.getByTestId("plan-go-to-request").click();
});

Then("{string} has the focus", async ({ page }, name: string) => {
  // The button of the permission panel: the plan card above it has one of the same name.
  await expect(page.getByTestId("permission-panel").filter({ visible: true }).first().getByRole("button", { name, exact: true })).toBeFocused();
});

Then("the permission request is still open", async ({ page }) => {
  await expect(page.getByTestId("permission-panel")).toBeVisible();
});

When("I move the Plan pane to the main area from its tab menu", async ({ page }) => {
  await menuOf(side(page).getByTestId("pane-plan"));
  await page.getByTestId("pane-move-main").click();
});

Then("the plan tab opens right of its session tab and has the focus", async ({ page }) => {
  await expect(planTabs(page)).toHaveCount(1);
  await expect(planTab(page)).toContainText("Plan ·");
  await expect(planTabButton(page)).toHaveAttribute("aria-selected", "true");
  await expectRightOfSession(page);
});

Then("the plan tab is right of its session tab", async ({ page }) => {
  await expectRightOfSession(page);
});

async function expectRightOfSession(page: Page): Promise<void> {
  const ids = await stripIds(page);
  const at = ids.findIndex((i) => i.startsWith("plan:"));
  expect(at).toBeGreaterThan(0);
  expect(ids[at - 1]).toBe(ids[at]!.slice("plan:".length));
}

When("I click Open in tab on the plan card", async ({ page }) => {
  await page.getByTestId("tool-card").filter({ hasText: "ExitPlanMode" }).getByTestId("plan-open-tab").click();
});

Then("there is one plan tab and it has the focus", async ({ page }) => {
  await expect(planTabs(page)).toHaveCount(1);
  await expect(planTabButton(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-pane-tab-body^='plan:']")).toBeVisible();
});

Then("there is no plan tab", async ({ page }) => {
  await expect(planTabs(page)).toHaveCount(0);
});

When("I open a second session with a finished reply", async ({ page, project }) => {
  await page.getByTestId("tab-new").first().click();
  const fresh = page.getByTestId("new-session-tab");
  await expect(fresh).toBeVisible();
  await fresh.getByTestId("session-model").click();
  await page.getByRole("option", { name: "Haiku" }).click();
  await expect(fresh.getByTestId("session-model")).toContainText("Haiku");
  await expect(fresh.getByTestId("project-chip")).toContainText(project.name);
  await fresh.getByRole("combobox", { name: "First prompt" }).fill(REPLY_PROMPT);
  await expect(fresh.getByTestId("send")).toBeEnabled();
  await fresh.getByTestId("send").click();
  const second = page.locator('[data-testid="session-area"]:visible, [data-testid="session-area"]').last();
  await expect(second.getByTestId("assistant-text").last()).toHaveText(/\S/, { timeout: TURN_MS });
  await expect(page.locator('[data-testid="send"][data-state="idle"]').last()).toBeVisible({ timeout: TURN_MS });
});

Then("the sidebar highlights the second session", async ({ page }) => {
  const ids = (await stripIds(page)).filter((i) => i && !i.startsWith("plan:"));
  expect(ids.length).toBe(2);
  const active = page.locator('[data-testid="session-item"][aria-current="page"]');
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("data-session-id", ids[1]!);
});

When("I click the plan tab", async ({ page }) => {
  await planTabButton(page).click();
});

Then("the sidebar highlights the session of the plan tab", async ({ page }) => {
  const id = (await planTab(page).getAttribute("data-tab-id"))!.slice("plan:".length);
  await expect(page.locator('[data-testid="session-item"][aria-current="page"]')).toHaveAttribute("data-session-id", id);
});

Then("the side panel shows panes of that session", async ({ page }) => {
  await expect(side(page)).toBeVisible();
  await expect(side(page).locator("[data-pane-tab]").first()).toBeVisible();
  // The Plan pane left the docks: its tab is not there, but the session's own panes are.
  await expect(side(page).getByTestId("pane-plan")).toHaveCount(0);
  await expect(side(page).getByTestId("pane-files")).toBeVisible();
});

Then("the stored layout has Plan in the main area", async ({ page }) => {
  const layout = await page.evaluate(() => JSON.parse(localStorage.getItem("claude-ui.layout") ?? "{}"));
  expect(layout.areas?.main ?? layout.main).toContain("plan");
});

When("I open the menu of the plan tab", async ({ page }) => {
  await menuOf(planTab(page));
});

Then("the menu item {string} is disabled", async ({ page }, label: string) => {
  const item = page.getByRole("menuitem", { name: label, exact: true });
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("aria-disabled", "true");
});

When("I choose {string} in the plan tab menu", async ({ page }, label: string) => {
  if (label.startsWith("Move Plan")) await menuOf(planTab(page));
  await page.getByRole("menuitem", { name: label, exact: true }).click();
});

Then("the plan tab is pinned", async ({ page }) => {
  await expect(planTab(page)).toHaveAttribute("data-pinned", "true");
});

Then("the session tab is active", async ({ page }) => {
  const id = (await planTab(page).getAttribute("data-tab-id"))!.slice("plan:".length);
  await expect(page.locator(`[data-testid="tab"][data-tab-id="${id}"] [role="tab"]`)).toHaveAttribute("aria-selected", "true");
});

When("I click Undo in the toast", async ({ page }) => {
  await toast(page).getByRole("button", { name: "Undo" }).click();
});

When("I choose Reset layout in the side panel menu", async ({ page }) => {
  await page.getByTestId("dock-menu-side").click();
  await page.getByTestId("dock-reset").click();
});

Then("the pane switcher lists Plan", async ({ page }) => {
  await expect(page.getByTestId("pane-plan").first()).toBeVisible();
  await expect(page.getByTestId("pane-session").first()).toBeVisible();
});

When("I open the tab switcher", async ({ page }) => {
  await page.getByTestId("tab-switcher").click();
});

Then("the tab switcher lists a plan row", async ({ page }) => {
  const rows = page.getByRole("option").filter({ hasText: "Plan ·" });
  await expect(rows).toHaveCount(1);
});

When("I go to the session tab", async ({ page }) => {
  const id = (await planTab(page).getAttribute("data-tab-id"))!.slice("plan:".length);
  await page.locator(`[data-testid="tab"][data-tab-id="${id}"] [role="tab"]`).click();
});

When("I keep planning in the first session", async ({ page }) => {
  await planTabButton(page).click();
  const id = (await planTab(page).getAttribute("data-tab-id"))!.slice("plan:".length);
  await page.locator(`[data-testid="tab"][data-tab-id="${id}"] [role="tab"]`).click();
  await page.getByTestId("permission-panel").getByRole("button", { name: /^(No, keep planning|Deny)/ }).click();
  await expect(page.getByTestId("permission-panel")).toBeHidden();
});

Then("the focus is inside the permission request", async ({ page }) => {
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="permission-panel"]'))).toBe(true);
});

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();

Then("the approval panel shows the plan and Open plan in popup", async ({ page }) => {
  const panel = page.getByTestId("permission-panel").filter({ visible: true }).first();
  await expect(panel.getByTestId("plan")).toHaveText(/\S/);
  await expect(panel.getByTestId("plan").locator("p, ol, ul, li, h1, h2, h3").first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Open plan in popup", exact: true })).toBeVisible();
});

Then("the Plan tab shows the same plan as the approval panel", async ({ page }) => {
  const panel = page.getByTestId("permission-panel").filter({ visible: true }).first();
  const fromPanel = norm(await panel.getByTestId("plan").textContent());
  await side(page).getByTestId("pane-plan").click();
  await expect(page.getByTestId("plan-pane")).toBeVisible();
  expect(fromPanel.length).toBeGreaterThan(0);
  expect(norm(await page.getByTestId("plan-pane").textContent())).toContain(fromPanel);
});

Then("the plan card shows a plan", async ({ page }) => {
  const card = page.getByTestId("tool-card").filter({ hasText: /^\s*ExitPlanMode/ }).first();
  await expect(card).toBeVisible({ timeout: TURN_MS });
  // Collapsed after a reload: expand it to read the plan.
  if ((await card.getByTestId("plan").count()) === 0) await card.getByRole("button", { name: /^ExitPlanMode/ }).click();
  await expect(card.getByTestId("plan")).toHaveText(/\S/);
});

Then("the Plan tab shows the plan of the plan card", async ({ page }) => {
  const card = page.getByTestId("tool-card").filter({ hasText: /^\s*ExitPlanMode/ }).first();
  const fromCard = norm(await card.getByTestId("plan").textContent());
  await side(page).getByTestId("pane-plan").click();
  await expect(page.getByTestId("plan-pane")).toBeVisible();
  expect(fromCard.length).toBeGreaterThan(0);
  expect(norm(await page.getByTestId("plan-pane").textContent())).toContain(fromCard);
});

// --- Approval, revised plan, palette without a plan ---
const REVISE_TOKEN = "ZEBRA-7731";
let planBeforeAnswer = "";
const approvalPanel = (page: Page) => page.getByTestId("permission-panel").filter({ visible: true }).first();
const exitCard = (page: Page) => page.getByTestId("tool-card").filter({ hasText: /^\s*ExitPlanMode/ }).first();

When("I remember the plan of the approval panel", async ({ page }) => {
  planBeforeAnswer = norm(await approvalPanel(page).getByTestId("plan").textContent());
  expect(planBeforeAnswer.length).toBeGreaterThan(0);
});

When("I approve the plan with {string}", async ({ page }, label: string) => {
  await approvalPanel(page).getByRole("button", { name: label, exact: true }).click();
});

Then("the session leaves Plan mode", async ({ page }) => {
  const settings = page.getByTestId("session-settings");
  const phone = await settings.isVisible();
  if (phone) await settings.click();
  await expect(page.getByTestId("mode-select")).not.toHaveAttribute("aria-label", /^Plan mode/, { timeout: TURN_MS });
  if (phone) await page.keyboard.press("Escape");
});

Then("Claude goes on after the approval", async ({ page }) => {
  // Something follows the ExitPlanMode card: a reply, another tool call or a new request.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const cards = [...document.querySelectorAll('[data-testid="tool-card"]')];
          const at = cards.findIndex((c) => /^\s*ExitPlanMode/.test(c.textContent ?? ""));
          const after = cards.slice(at + 1).length > 0;
          const replies = document.querySelectorAll('[data-testid="assistant-text"]').length > 0;
          const asks = document.querySelectorAll('[data-testid="permission-panel"]').length > 0;
          return after || replies || asks;
        }),
      { timeout: TURN_MS },
    )
    .toBe(true);
});

Then("the ExitPlanMode card is finished and not marked as edited by me", async ({ page }) => {
  const card = exitCard(page);
  await expect(card).toHaveAttribute("data-status", "done", { timeout: TURN_MS });
  expect(norm(await card.textContent())).not.toMatch(/edited by (you|user)/i);
  await expect(page.getByText(/edited by (you|the user|user)/i)).toHaveCount(0);
});

Then("the ExitPlanMode card shows the plan I approved", async ({ page }) => {
  const card = exitCard(page);
  if ((await card.getByTestId("plan").count()) === 0) await card.getByRole("button", { name: /^ExitPlanMode/ }).click();
  expect(norm(await card.getByTestId("plan").textContent())).toContain(planBeforeAnswer);
});

Given("a Haiku session in Plan mode whose plan file is drafted", async ({ page, daemon, project }) => {
  await openApp(page, daemon);
  await openProject(page, project.path);
  await prepareHaikuSession(page, project.name);
  await chooseMode(page, "Plan mode");
  await sendPrompt(
    page,
    "Plan only. Write a two-step markdown plan (create hello.txt containing hi; verify it) to your plan file with the Write tool. Do not call ExitPlanMode yet. Then reply with the single word: drafted.",
  );
  await expect(page.locator('[data-testid="tool-card"]').filter({ hasText: /^\s*Write/ }).first()).toBeVisible({ timeout: TURN_MS });
  await expect(page.locator('[data-testid="send"][data-state="idle"]').last()).toBeVisible({ timeout: TURN_MS });
});

When("I ask to revise step 2 with the marker and to submit the plan", async ({ page }) => {
  await sendPrompt(
    page,
    `Edit your plan file with the Edit tool: replace the text of step 2 with exactly "${REVISE_TOKEN} verify hello.txt". Do not rewrite the file. Then call ExitPlanMode with no other tool in between.`,
  );
  await expect(page.getByTestId("permission-panel")).toBeVisible({ timeout: TURN_MS });
});

Then("the approval panel shows the revised step", async ({ page }) => {
  await expect(approvalPanel(page).getByTestId("plan")).toContainText(REVISE_TOKEN, { timeout: TURN_MS });
});

Then("the Plan tab shows the revised step", async ({ page }) => {
  await side(page).getByTestId("pane-plan").click();
  await expect(page.getByTestId("plan-pane")).toContainText(REVISE_TOKEN);
});

When("I run {string} from the command palette", async ({ page }, title: string) => {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox").or(palette.locator("input")).first().fill(title);
  await palette.getByRole("option", { name: new RegExp(`^${title}`, "i") }).first().click();
});
