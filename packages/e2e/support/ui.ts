// Locators and waits shared by the step files. Structure only: never reply wording.
import { expect, type Locator, type Page } from "@playwright/test";

/** Longest a real Haiku turn (start, tool, reply) may take. */
export const TURN_MS = 120_000;
export const RECONNECT_MS = 60_000;

/** A new session's first prompt is "First prompt", every later box "Prompt". */
export const promptBox = (page: Page): Locator => page.getByRole("combobox", { name: /^(First prompt|Prompt)$/ });
export const sendButton = (page: Page): Locator => page.getByTestId("send");
export const idleSend = (page: Page): Locator => page.locator('[data-testid="send"][data-state="idle"]');
export const lastToolCard = (page: Page): Locator => page.getByTestId("tool-card").last();

export async function waitConnected(page: Page): Promise<void> {
  // On a phone the connection badge lives in the drawer: it is attached but not always visible.
  await expect(page.getByTestId("connection-status").first()).toHaveText(/^\s*connected\s*$/, { timeout: RECONNECT_MS });
  await expect(page.getByTestId("pairing-needed")).toHaveCount(0);
}
