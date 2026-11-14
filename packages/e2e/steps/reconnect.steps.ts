import type { Page, WebSocketRoute } from "@playwright/test";
import { expect } from "@playwright/test";
import { TURN_MS } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

/** The page's daemon sockets of a scenario: `offline` refuses new ones, `open` are the ones a cut closes. */
type Cut = { offline: boolean; open: Set<WebSocketRoute> };
const cuts = new WeakMap<Page, Cut>();

// GH-767: a page that loses its socket (phone asleep, wifi gone) reconnects and catches up. Playwright's `setOffline` leaves an open WebSocket
// alone in Chromium, so the page's socket goes through a route that can end it, like a network failure, and refuse the next dials meanwhile.
Given("the page's connection to the daemon can be cut", async ({ page }) => {
  const cut: Cut = { offline: false, open: new Set() };
  cuts.set(page, cut);
  await page.routeWebSocket(/\/ws(\?|$)/, (ws) => {
    if (cut.offline) return void ws.close({ code: 1001, reason: "offline" });
    ws.connectToServer();
    cut.open.add(ws);
    ws.onClose(() => cut.open.delete(ws));
  });
});

When("the connection to the daemon is cut", async ({ page }) => {
  const cut = cuts.get(page);
  if (!cut) throw new Error('add "the page\'s connection to the daemon can be cut" before the app is opened');
  cut.offline = true;
  for (const ws of [...cut.open]) ws.close({ code: 1001, reason: "offline" });
  cut.open.clear();
});

When("the connection to the daemon is back", async ({ page }) => {
  cuts.get(page)!.offline = false;
});

When("I open a second new session tab", async ({ page, project }) => {
  await page.getByTestId("tab-new").first().click();
  // The first session's header is still in the page: the choices are scoped to the new-session tab.
  const tab = page.getByTestId("new-session-tab");
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId("project-chip")).toContainText(project.name);
  const model = tab.getByTestId("session-model");
  await model.click();
  await page.getByRole("option", { name: "Haiku" }).click();
  await expect(model).toContainText("Haiku");
});

// Tab 0 is Focus; session tabs follow in the order they were opened.
When("I switch to session tab {int}", async ({ page }, n: number) => {
  await page.getByTestId("tab-strip").getByRole("tab").nth(n).click();
});

// Two sessions are mounted: the shared steps expect one, so these look at the shown one only.
When("I send {string} in the new session tab", async ({ page }, text: string) => {
  const tab = page.getByTestId("new-session-tab");
  await tab.getByRole("combobox", { name: /^First prompt$/ }).fill(text);
  await tab.getByTestId("send").click();
  // Sent: the tab became the session. A cut before that would fail the send instead of changing a session while offline.
  await expect(tab).toHaveCount(0, { timeout: 30_000 });
});

Then("the shown session has a reply from Claude", async ({ page }) => {
  await expect(page.locator('[data-testid="assistant-text"]:visible').first()).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the shown session's turn has finished", async ({ page }) => {
  await expect(page.locator('[data-testid="send"][data-state="idle"]:visible')).toBeVisible({ timeout: TURN_MS });
});

// The reply of the counting prompt is whole once its last word shows (a cut-off text would end in a number).
Then("the shown reply has its last word", async ({ page }) => {
  await expect(page.locator('[data-testid="assistant-text"]:visible').last()).toContainText(/done/i, { timeout: 15_000 });
});
