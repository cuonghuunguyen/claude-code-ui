import type { Page, WebSocketRoute } from "@playwright/test";
import { expect } from "@playwright/test";
import { REPLY_PROMPT, sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { TURN_MS, waitConnected } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

/**
 * GH-771 view cache. A reloaded page must show the cached session before the daemon answers, so the page's daemon socket is held.
 *
 * Hold variant (probed before writing this, Chromium via Playwright 1.64): a `routeWebSocket` handler that is async and awaits a release
 * promise before `connectToServer()` keeps the page's socket in CONNECTING (readyState 0, no `open`, no `close`). So the variant is the
 * real hold, not the mocked-open one: the page sees no socket, status shows reconnecting/connecting, and no `daemon_hello` arrives.
 * On release the handler connects to the daemon, so the dial that was waiting completes normally (no redial through a closed mock).
 * The daemon's frames pass through `connectToServer().onMessage`, forwarded by hand, so the steps can read the subscribe reply.
 */
type Hold = { held: boolean; gate: Promise<void>; open: () => void; frames: string[] };
const holds = new WeakMap<Page, Hold>();

const holdOf = (page: Page): Hold => {
  const hold = holds.get(page);
  if (!hold) throw new Error('add "the page\'s connection to the daemon can be held" before the app is opened');
  return hold;
};

Given("the page's connection to the daemon can be held", async ({ page }) => {
  const hold: Hold = { held: false, gate: Promise.resolve(), open: () => {}, frames: [] };
  holds.set(page, hold);
  await page.routeWebSocket(/\/ws(\?|$)/, async (ws: WebSocketRoute) => {
    let closed = false;
    ws.onClose(() => {
      closed = true;
    });
    while (hold.held) await hold.gate;
    // The page may have been reloaded while this dial waited: its socket is gone, so no daemon socket is opened for it.
    if (closed) return;
    try {
      const server = ws.connectToServer();
      server.onMessage((message) => {
        if (typeof message === "string") hold.frames.push(message);
        ws.send(message);
      });
    } catch {
      // The page socket closed between the check and the connect.
    }
  });
});

When("the connection to the daemon is held", async ({ page }) => {
  const hold = holdOf(page);
  if (hold.held) return;
  hold.held = true;
  hold.gate = new Promise<void>((resolve) => {
    hold.open = resolve;
  });
});

When("the connection to the daemon is released", async ({ page }) => {
  const hold = holdOf(page);
  hold.held = false;
  hold.open();
});

When("I reload the page without waiting for the connection", async ({ page }) => {
  holdOf(page).frames.length = 0;
  await page.reload();
});

When("I open the app again without waiting for the connection", async ({ page, daemon }) => {
  holdOf(page).frames.length = 0;
  await page.goto(daemon.origin);
});

When("I leave the page", async ({ page }) => {
  await page.goto("about:blank");
});

Then("the connection status is not connected", async ({ page }) => {
  const status = page.getByTestId("connection-status").first();
  await expect(status).toBeAttached();
  expect(await status.getAttribute("data-status")).not.toBe("connected");
  // Held for a moment longer: the cached view must not depend on the socket becoming ready.
  await page.waitForTimeout(500);
  expect(await status.getAttribute("data-status")).not.toBe("connected");
});

// ---- IndexedDB `claude-ui-cache` (read only; opening a missing database would create an empty one the app could not upgrade) ----

/** `shownFinished`: the record of the session in the page's hash holds the finished turn (idle, with an assistant reply). */
type CacheState = { exists: boolean; views: number; shownFinished: boolean };

async function cacheState(page: Page): Promise<CacheState> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "claude-ui-cache")) return { exists: false, views: 0, shownFinished: false };
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open("claude-ui-cache");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const names = Array.from(db.objectStoreNames);
      const ask = <T>(store: string, get: (s: IDBObjectStore) => IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          const req = get(db.transaction(store, "readonly").objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const views = names.includes("viewMeta") ? (await ask("viewMeta", (s) => s.getAllKeys())).length : 0;
      // The shown session only: a background view of another scenario's session (same daemon) must not stand in for it.
      const id = decodeURIComponent(location.hash.slice(1).split("/")[0] ?? "");
      const row = id && names.includes("viewData") ? ((await ask("viewData", (s) => s.get(id))) as { json?: unknown } | undefined) : undefined;
      const json = typeof row?.json === "string" ? row.json : "";
      return { exists: true, views, shownFinished: json.includes('"state":"idle"') && json.includes('"assistant_text"') };
    } finally {
      db.close();
    }
  });
}

Then("the view cache has saved the finished session", async ({ page }) => {
  // Saves are debounced (2 s quiet, 5 s gap): wait for the shown session's record that already holds the finished turn.
  await expect.poll(async () => (await cacheState(page)).shownFinished, { timeout: 30_000, intervals: [500], message: "view cache" }).toBe(true).catch(async (e) => {
    throw new Error(`${(e as Error).message} state=${JSON.stringify(await cacheState(page))}`);
  });
});

Then("the view cache holds no session", async ({ page }) => {
  await expect.poll(async () => (await cacheState(page)).views, { timeout: 15_000, intervals: [500] }).toBe(0);
});

// ---- Transcript structure ----

const transcript = (page: Page) => page.locator('[role="log"]:visible [data-key]');
const keysOf = (page: Page) => transcript(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-key") ?? ""));

const sentPrompts = (page: Page) => page.locator('[data-testid="user-message"]:not([data-pending])');

Then("the shown session has {int} prompt(s) and {int} reply/replies", async ({ page }, prompts: number, replies: number) => {
  await expect(sentPrompts(page)).toHaveCount(prompts, { timeout: TURN_MS });
  await expect(page.getByTestId("assistant-text")).toHaveCount(replies, { timeout: TURN_MS });
});

// Held a moment: a duplicated part (cache plus resume) would show up as a second block.
Then("the shown session still has {int} prompt(s) and {int} reply/replies", async ({ page }, prompts: number, replies: number) => {
  await page.waitForTimeout(1000);
  await expect(sentPrompts(page)).toHaveCount(prompts);
  await expect(page.getByTestId("assistant-text")).toHaveCount(replies);
});

Then("the cached session shows its cost footer", async ({ page }) => {
  await expect(page.getByTestId("turn-result")).toHaveCount(1);
});

Then("the shown session has no cost footer", async ({ page }) => {
  await expect(page.getByTestId("turn-result")).toHaveCount(0);
});

// ---- Another page of the same browser context ----

// `indexedDB` is absent here: these pages work without a cache and cannot touch the one of the first page.
const blockIndexedDb = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", { configurable: true, value: undefined });
  });

const openOtherPage = async (page: Page, origin: string): Promise<Page> => {
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  // Without IndexedDB this page cannot overwrite the cache the first page saved.
  await blockIndexedDb(other);
  await other.goto(origin);
  await waitConnected(other);
  return other;
};

// A new page of the browser does not reopen the tabs: it opens the (only) session of the scratch project from the sidebar, like a user.
const openTheSession = async (other: Page): Promise<void> => {
  const item = other.getByTestId("session-item").first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.click();
};

When("another page of the same browser finishes a second turn in the session", async ({ page, daemon }) => {
  const other = await openOtherPage(page, daemon.origin);
  try {
    await openTheSession(other);
    await expect(sentPrompts(other)).toHaveCount(1, { timeout: 30_000 });
    await sendPrompt(other, REPLY_PROMPT);
    await expect(sentPrompts(other)).toHaveCount(2, { timeout: TURN_MS });
    await expect(other.getByTestId("assistant-text")).toHaveCount(2, { timeout: TURN_MS });
    await waitTurnEnd(other);
  } finally {
    await other.close();
  }
});

// ---- Daemon restart ----

const partKeys = new WeakMap<Page, string[]>();

Then("I note the part ids of the shown session", async ({ page }) => {
  await expect(transcript(page).first()).toBeVisible();
  partKeys.set(page, await keysOf(page));
  expect(partKeys.get(page)!.length).toBeGreaterThan(1);
});

Then("the part ids of the shown session equal those of a fresh page", async ({ page, daemon }) => {
  const resynced = await keysOf(page);
  const fresh = await openOtherPage(page, daemon.origin);
  try {
    await openTheSession(fresh);
    await expect(sentPrompts(fresh)).toHaveCount(1, { timeout: 30_000 });
    await expect(fresh.getByTestId("assistant-text")).toHaveCount(1, { timeout: TURN_MS });
    await waitTurnEnd(fresh);
    expect(resynced).toEqual(await keysOf(fresh));
  } finally {
    await fresh.close();
  }
});

Then("the resume reply of the session carries refs for the cached parts", async ({ page }) => {
  const hold = holdOf(page);
  await expect
    .poll(
      () =>
        hold.frames.some((f) => {
          if (!f.includes('"refs":true')) return false;
          const msg = JSON.parse(f) as { type?: string; result?: { snapshot?: { refs?: boolean; page?: { parts?: { ref?: string }[] } } } };
          return msg.type === "reply" && msg.result?.snapshot?.refs === true && !!msg.result.snapshot.page?.parts?.some((p) => typeof p.ref === "string");
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
});

Then("the resume reply of the session sends no cached part in full", async ({ page }) => {
  const hold = holdOf(page);
  const snapshots = hold.frames.flatMap((f) => {
    if (!f.includes('"refs":true')) return [];
    const msg = JSON.parse(f) as { type?: string; result?: { snapshot?: { refs?: boolean; page?: { parts?: { ref?: string; type?: string }[] } } } };
    return msg.type === "reply" && msg.result?.snapshot?.refs === true ? [msg.result.snapshot.page?.parts ?? []] : [];
  });
  expect(snapshots.length).toBeGreaterThan(0);
  const full = snapshots.flat().filter((p) => typeof p.ref !== "string").map((p) => p.type);
  // Only parts the cache did not hold may come in full (the restored transcript has no turn_result: it is never sent, never a ref).
  expect(full.filter((t) => t === "user_text" || t === "assistant_text")).toEqual([]);
});

// ---- Unpair ----

When("the stored pairing token is replaced by a wrong one and the page reloads", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("claude-ui.token", "x".repeat(43)));
  await page.reload();
});

Then("the pairing form shows", async ({ page }) => {
  await expect(page.getByTestId("pairing-needed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("connection-status").first()).toHaveAttribute("data-status", "unauthorized");
});
