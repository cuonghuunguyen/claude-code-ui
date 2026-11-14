// Session skeleton steps (GH-774): the daemon's subscribe replies are held on the socket, so the loading state stays on screen.
import { expect } from "@playwright/test";
import { Given, Then, When } from "./fixtures.ts";

type Box = { x: number; y: number; width: number; height: number };
// Per worker process; "subscribes can be held" resets it at the start of every scenario that uses it.
const hold = { on: false, queue: [] as string[], send: undefined as ((m: string) => void) | undefined };
const skeleton = (page: import("@playwright/test").Page) => page.getByTestId("session-skeleton");

Given("subscribes can be held", async ({ page }) => {
  hold.on = false;
  hold.queue = [];
  hold.send = undefined;
  // Delays the request, not the reply: the reply precedes its replayed events on the socket, a held reply alone would reorder them.
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    hold.send = (m) => server.send(m);
    ws.onMessage((m) => {
      if (hold.on && typeof m === "string" && (JSON.parse(m) as { type?: string }).type === "session.subscribe") hold.queue.push(m);
      else server.send(m);
    });
  });
});

When("the daemon holds session subscribes", () => void (hold.on = true));

When("the held subscribes are released", () => {
  hold.on = false;
  for (const m of hold.queue.splice(0)) hold.send!(m);
});

Given("the color scheme is dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
});

Then("the session skeleton shows in the main area", async ({ page }) => {
  const sk = page.locator('[data-testid="session-area"] [data-testid="session-skeleton"]:visible');
  await expect(sk.first()).toBeVisible();
  await expect(sk.first()).toHaveAttribute("aria-busy", "true");
});

Then("the main area does not ask to open or create a session", async ({ page }) => {
  await expect(page.getByText("Open or create a session to start.")).toHaveCount(0);
});

Then("the session skeleton shows in the aside popup", async ({ page }) => {
  await expect(page.locator("[data-aside-popup]").getByTestId("session-skeleton")).toBeVisible();
});

Then("the session skeleton shows in a split", async ({ page }) => {
  await expect(page.locator('[data-testid="split"] [data-testid="session-skeleton"]').first()).toBeVisible();
});

Then("the session skeleton has no header", async ({ page }) => {
  await expect(skeleton(page).first()).toBeVisible();
  await expect(skeleton(page).first().getByTestId("session-header")).toHaveCount(0);
});

const boxes = async (page: import("@playwright/test").Page) => ({
  composer: (await page.getByTestId("prompt-skeleton").first().boundingBox()) as Box | null,
  header: (await page.getByTestId("session-header").first().boundingBox().catch(() => null)) as Box | null,
});

Then("I note the skeleton boxes", async ({ page, memo }) => {
  // The panels (and so the width of the main area) are known once the session list is there: its header shows the project.
  await expect(skeleton(page).first().getByTestId("session-project")).toBeVisible();
  memo.layout = await boxes(page);
});

Then("the session pane replaced the skeleton in place", async ({ page, memo }) => {
  await expect(page.locator('[data-testid="session-area"] [data-testid="session-skeleton"]:visible')).toHaveCount(0);
  await expect(page.locator('[data-testid="session-area"] textarea[aria-label="Prompt"]:visible').first()).toBeVisible();
  const before = memo.layout as { composer: Box | null; header: Box | null } | undefined;
  if (!before?.composer) return;
  const header = await page.getByTestId("session-header").first().boundingBox();
  if (before.header && header) {
    expect(Math.abs(header.x - before.header.x), "header x").toBeLessThanOrEqual(1);
    expect(Math.abs(header.y - before.header.y), "header y").toBeLessThanOrEqual(1);
    expect(Math.abs(header.height - before.header.height), "header height").toBeLessThanOrEqual(1);
  }
  const prompt = await page.locator('[data-testid="session-area"] textarea[aria-label="Prompt"]:visible').first().boundingBox();
  // The composer box (textarea) sits inside the 104px block the skeleton reserved.
  expect(prompt!.x, "composer left").toBeGreaterThanOrEqual(before.composer.x - 2);
  expect(prompt!.y + prompt!.height, "composer bottom").toBeLessThanOrEqual(before.composer.y + before.composer.height + 2);
});

Then("both session splits are shown", async ({ page }) => {
  await expect(page.locator('[data-testid="split"]:not([data-pane-tab-body]) textarea[aria-label="Prompt"]')).toHaveCount(2);
  await expect(page.getByTestId("session-skeleton")).toHaveCount(0);
});
