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

Then("a toast says {string}", async ({ page }, text: string) => {
  await expect(toast(page)).toContainText(text);
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
