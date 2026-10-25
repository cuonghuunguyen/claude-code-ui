import { expect, type Page } from "@playwright/test";
import { sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { TURN_MS } from "../support/ui.ts";
import { Then, When } from "./fixtures.ts";

When("I send {string}", async ({ page }, text: string) => {
  await sendPrompt(page, text);
});

When("I stop the turn", async ({ page }) => {
  await page.getByTestId("toolbar-stop").click();
});

Then("I see my prompt in the transcript", async ({ page }) => {
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])').first()).toBeVisible({ timeout: TURN_MS });
});

Then("I see a reply from Claude", async ({ page }) => {
  // Structure only: a reply block with some text, never its wording.
  await expect(page.getByTestId("assistant-text").first()).toHaveText(/\S/, { timeout: TURN_MS });
});

Then("the turn has finished", async ({ page }) => {
  await waitTurnEnd(page);
});

const shellBox = (page: Page) => page.getByRole("combobox", { name: /^(First prompt|Prompt|Shell command)$/ });
const chips = (page: Page) => page.getByTestId("queue-chips");

When("I run the shell command {string}", async ({ page }, command: string) => {
  const box = shellBox(page);
  await box.click();
  await page.keyboard.type("!");
  await expect(page.getByTestId("bash-mode")).toBeVisible();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
});

When("I queue {string}", async ({ page }, text: string) => {
  const box = shellBox(page);
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Alt+Enter");
});

When("I edit the queued shell command", async ({ page }) => {
  await chips(page).locator("li").first().locator('[data-action="edit"]').click();
});

Then("the queue shows the shell command {string}", async ({ page }, command: string) => {
  const row = chips(page).locator("li").filter({ hasText: command });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("!");
  // The command is shown in monospace.
  await expect(row.locator("span.font-mono").last()).toHaveText(command);
});

Then("the queue lists {int} items", async ({ page }, n: number) => {
  await expect(chips(page).locator("li")).toHaveCount(n, { timeout: 30_000 });
});

Then("the queue is empty", async ({ page }) => {
  await expect(chips(page)).toBeHidden({ timeout: TURN_MS });
});

Then("the prompt box is empty", async ({ page }) => {
  await expect(shellBox(page)).toHaveValue("");
});

Then("no prompt error shows", async ({ page }) => {
  await expect(page.getByTestId("prompt-error")).toHaveCount(0);
});

Then("a bash card shows {string}", async ({ page }, text: string) => {
  await expect(page.getByTestId("bash-card").filter({ hasText: text })).toBeVisible({ timeout: TURN_MS });
});

Then("Send now on the queued shell command is disabled with a reason", async ({ page }) => {
  const send = chips(page).locator("li").first().locator('[data-action="send"]');
  await expect(send).toHaveAttribute("aria-disabled", "true");
  await expect(send).toHaveAttribute("title", /\S{5,}/);
  await send.click({ force: true, timeout: 3_000 });
  // Click is a no-op: the chip stays.
  await expect(chips(page).locator("li")).toHaveCount(1);
});

Then("the prompt box is in bash mode with {string}", async ({ page }, command: string) => {
  await expect(page.getByTestId("bash-mode")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Shell command" })).toHaveValue(command);
});

Then("the transcript shows a prompt, a bash card, a prompt in that order after the first prompt", async ({ page }) => {
  await expect(page.locator('[data-testid="user-message"]:not([data-pending])')).toHaveCount(3, { timeout: TURN_MS });
  const seq = await page.locator('[data-testid="user-message"]:not([data-pending]), [data-testid="bash-card"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  expect(seq).toEqual(["user-message", "user-message", "bash-card", "user-message"]);
});
