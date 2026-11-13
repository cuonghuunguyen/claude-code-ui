import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { Given, Then, When } from "./fixtures.ts";

type Exported = { name: string; lines: { time: string; level: string; message: string; path: string; version: string }[]; text: string };
const exported = new WeakMap<Page, Exported>();

const section = (page: Page) => page.getByTestId("settings-browser-logs");
const status = (page: Page) => page.getByTestId("settings-browser-logs-status");
const keep = (page: Page) => page.getByTestId("settings-browser-logs-keep");

async function openAbout(page: Page) {
  // A phone shows the sidebar, and its Settings button, in a drawer.
  const drawer = page.getByTestId("open-drawer");
  if (await drawer.isVisible()) await drawer.click();
  const open = page.getByTestId("open-settings").last();
  await expect(open).toBeInViewport();
  await open.click();
  await page.getByTestId("settings-group-about").click();
  await expect(section(page)).toBeVisible();
}

Given("browser storage is blocked", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
  });
});

When("the page logs an error", async ({ page }) => {
  await page.evaluate(() => console.error("e2e-console"));
  // The logger writes 1 s after the first entry.
  await page.waitForTimeout(1500);
});

When("the page logs an error, a window error and an unhandled rejection", async ({ page }) => {
  await page.evaluate(() => {
    const token = localStorage.getItem("claude-ui.token") ?? "";
    console.error("e2e-console", `${location.href}#token=${token}`, token);
    setTimeout(() => {
      throw new Error("e2e-window");
    });
    void Promise.reject(new Error("e2e-rejection"));
  });
  await page.waitForTimeout(1500);
});

When("I open Settings › About", async ({ page }) => {
  await openAbout(page);
});

When("I reopen Settings › About", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-dialog")).toBeHidden();
  await openAbout(page);
});

When("I export browser logs", async ({ page }) => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("settings-browser-logs-export").click()]);
  const text = readFileSync((await download.path())!, "utf8");
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Exported["lines"][number]);
  exported.set(page, { name: download.suggestedFilename(), lines, text });
});

When("I click Clear browser logs", async ({ page }) => {
  await page.getByTestId("settings-browser-logs-clear").click();
});

When("I cancel clearing browser logs", async ({ page }) => {
  await page.getByTestId("settings-browser-logs-clear-confirm").getByRole("button", { name: "Cancel" }).click();
});

When("I confirm clearing browser logs", async ({ page }) => {
  await page.getByTestId("settings-browser-logs-clear-yes").click();
});

When("I turn Keep browser logs off", async ({ page }) => {
  if ((await keep(page).getAttribute("aria-checked")) === "true") await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "false");
});

When("I turn Keep browser logs on", async ({ page }) => {
  if ((await keep(page).getAttribute("aria-checked")) === "false") await keep(page).click();
  await expect(keep(page)).toHaveAttribute("aria-checked", "true");
});

Then("Browser logs shows entries", async ({ page }) => {
  await expect(status(page)).toHaveText(/^\d+ entries since /);
});

Then("Browser logs asks to confirm", async ({ page }) => {
  await expect(page.getByTestId("settings-browser-logs-clear-confirm")).toBeVisible();
});

Then("Browser logs says there are no entries", async ({ page }) => {
  await expect(status(page)).toHaveText("No entries yet.");
});

Then("Browser logs says nothing is kept", async ({ page }) => {
  await expect(status(page)).toHaveText("Off: nothing is kept.");
});

Then("Browser logs says it is unavailable", async ({ page }) => {
  await expect(status(page)).toHaveText("Browser logs are unavailable: this browser blocks storage.");
  // The app itself works.
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
});

Then("Export browser logs and Clear browser logs are disabled", async ({ page }) => {
  await expect(page.getByTestId("settings-browser-logs-export")).toBeDisabled();
  await expect(page.getByTestId("settings-browser-logs-clear")).toBeDisabled();
});

Then("Browser logs is visible", async ({ page }) => {
  await expect(section(page)).toBeVisible();
  await section(page).scrollIntoViewIfNeeded();
});

Then("the browser logs buttons are at least 44 px tall", async ({ page }) => {
  for (const id of ["settings-browser-logs-export", "settings-browser-logs-clear", "settings-browser-logs-keep"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box, id).not.toBeNull();
    expect(box!.height, id).toBeGreaterThanOrEqual(44);
  }
});

Then("the browser logs file is named claude-ui-browser-logs-<date>.log", async ({ page }) => {
  expect(exported.get(page)!.name).toMatch(/^claude-ui-browser-logs-\d{4}-\d{2}-\d{2}\.log$/);
});

Then("the browser logs file has the console error, the window error and the rejection", async ({ page }) => {
  const { lines } = exported.get(page)!;
  for (const [needle, level] of [["e2e-console", "error"], ["e2e-window", "error"], ["e2e-rejection", "error"]] as const) {
    expect(lines.some((l) => l.message.includes(needle) && l.level === level), needle).toBe(true);
  }
  const times = lines.map((l) => Date.parse(l.time));
  expect(times).toEqual([...times].sort((a, b) => a - b));
});

Then("the window error and the rejection in the browser logs file have a stack", async ({ page }) => {
  const { lines } = exported.get(page)!;
  for (const needle of ["e2e-window", "e2e-rejection"]) {
    const l = lines.find((x) => x.message.includes(needle));
    expect(l?.message, needle).toMatch(/\n\s*at |@/);
  }
});

Then("the browser logs file holds no pairing token", async ({ page }) => {
  const token = await page.evaluate(() => localStorage.getItem("claude-ui.token"));
  expect(token, "the browser is paired").toBeTruthy();
  expect(exported.get(page)!.text).not.toContain(token!);
  expect(exported.get(page)!.text).toContain("[redacted]");
});
