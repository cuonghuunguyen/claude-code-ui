import type { Page, WebSocketRoute } from "@playwright/test";
import { expect } from "@playwright/test";
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

// The reply of the counting prompt is whole once its last word shows (a cut-off text would end in a number).
Then("the shown reply has its last word", async ({ page }) => {
  await expect(page.locator('[data-testid="assistant-text"]:visible').last()).toContainText(/done/i, { timeout: 15_000 });
});
