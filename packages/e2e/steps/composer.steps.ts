import { expect, type Page } from "@playwright/test";
import { sendPrompt, waitTurnEnd } from "../support/flow.ts";
import { promptBox, sendButton, TURN_MS } from "../support/ui.ts";
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

// GH-441: pasted text. A ClipboardEvent paste with text/plain on the prompt box (headless has no clipboard permission).
const pasteInto = async (page: Page, text: string) => {
  await promptBox(page).click();
  pasteHandled.set(page, await promptBox(page).evaluate((el, t) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    // false = the app called preventDefault (it took over the paste).
    return !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text));
};
const pasteHandled = new WeakMap<Page, boolean>();
const lineText = (n: number) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n");

When("I paste {int} lines into the prompt box", async ({ page }, n: number) => {
  await pasteInto(page, lineText(n));
});

When("I paste {string} into the prompt box", async ({ page }, text: string) => {
  await pasteInto(page, text);
});

Then("the prompt box shows {int} pasted-text chip(s)", async ({ page }, n: number) => {
  await expect(page.getByTestId("paste-chip")).toHaveCount(n);
});

Then("the prompt box is still small", async ({ page }) => {
  const h = (await promptBox(page).boundingBox())!.height;
  expect(h).toBeLessThanOrEqual(120);
});

// An untrusted paste event inserts nothing by itself: the browser default insertion is done for a trusted paste only.
// So: the app must leave the event alone (not prevented), then the default insertion is stood in for by insertText.
Then("the browser inserts the short paste {string} into the prompt box", async ({ page }, text: string) => {
  expect(pasteHandled.get(page), "the app left the paste event to the browser").toBe(false);
  await page.keyboard.insertText(text);
  await expect(promptBox(page)).toHaveValue(text);
});

When("I view the pasted text of the chip", async ({ page }) => {
  await page.getByRole("button", { name: "View pasted text #1" }).click();
});

Then("the pasted text viewer holds lines 1 to {int}", async ({ page }, n: number) => {
  const v = page.getByTestId("paste-viewer");
  await expect(v).toBeVisible();
  await expect(v).toContainText("line-1\n");
  const text = (await v.locator("pre").textContent()) ?? "";
  expect(text).toBe(lineText(n));
});

When("I close the pasted text viewer", async ({ page }) => {
  await page.getByRole("button", { name: "Close pasted text" }).click();
  await expect(page.getByTestId("paste-viewer")).toHaveCount(0);
});

When("I remove the pasted-text chip", async ({ page }) => {
  await page.getByRole("button", { name: /^Remove pasted text #\d+$/ }).first().click();
});

When("I type {string} after the paste", async ({ page }, text: string) => {
  await promptBox(page).click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
});

When("I send the prompt box", async ({ page }) => {
  await expect(sendButton(page)).toBeEnabled();
  await sendButton(page).click();
});

Then("the user message shows a collapsed pasted block of {int} lines", async ({ page }, n: number) => {
  const block = page.getByTestId("pasted-block").first();
  await expect(block).toBeVisible({ timeout: TURN_MS });
  await expect(block).toHaveText(`Pasted text · ${n} lines`);
  await expect(block).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("pasted-block-body")).toHaveCount(0);
});

When("I expand the pasted block", async ({ page }) => {
  await page.getByTestId("pasted-block").first().click();
});

Then("the pasted block holds lines 1 to {int}", async ({ page }, n: number) => {
  const body = page.getByTestId("pasted-block-body").first();
  await expect(body).toBeVisible();
  expect(((await body.textContent()) ?? "").trim()).toBe(lineText(n));
});

Then("the session list shows no pasted_content text", async ({ page }) => {
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveCount(1);
  const text = (await sidebar.textContent()) ?? "";
  expect(text).not.toContain("pasted_content");
  expect(await page.title()).not.toContain("pasted_content");
});
