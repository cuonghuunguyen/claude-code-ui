import { expect, type Page } from "@playwright/test";
import enApp from "../../web/src/i18n/en/app.ts";
import viApp from "../../web/src/i18n/vi/app.ts";
import { openSettings, waitConnected } from "../support/ui.ts";
import { Given, Then, When } from "./fixtures.ts";

// GH-510 UI language. The app's own labels come from its catalog, so the expected text is read from there.
const LANGS: Record<string, { code: string; settings: string }> = {
  English: { code: "en", settings: enApp["app.main.settings"] },
  Vietnamese: { code: "vi", settings: viApp["app.main.settings"] },
};

Given("the browser language is {string}", async ({ page }, tag: string) => {
  await page.addInitScript((l) => {
    Object.defineProperty(navigator, "language", { get: () => l });
    Object.defineProperty(navigator, "languages", { get: () => [l] });
  }, tag);
  await page.reload();
  await waitConnected(page);
});

Then("the app is in {word}", async ({ page }, lang: string) => {
  const { code, settings } = LANGS[lang];
  await expect(page.locator("html")).toHaveAttribute("lang", code);
  await expect(page.getByTestId("open-settings").last()).toContainText(settings);
});

async function chooseLanguage(page: Page, testId: string): Promise<void> {
  if (!(await page.getByTestId("settings-appearance").isVisible())) {
    await openSettings(page);
    await page.getByTestId("settings-group-appearance").click();
  }
  await page.getByTestId("settings-language").click();
  await page.getByTestId(`settings-language-${testId}`).click();
}

When("I choose the language {string} in Settings", async ({ page }, name: string) => {
  const id = name === "System" ? "system" : name === "Tiếng Việt" ? "vi" : "en";
  await chooseLanguage(page, id);
  await expect(page.getByTestId("settings-language")).toContainText(id === "system" ? /./ : name);
});

When("I switch the language to {word}", async ({ page }, lang: string) => {
  await chooseLanguage(page, LANGS[lang].code);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-appearance")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", LANGS[lang].code);
});

Then("no text is clipped in the open dialog or the sidebar", async ({ page }) => {
  // A label cut by its box: an element with text whose content is wider than the box while it hides overflow (no ellipsis by design).
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[role=dialog] *, aside *")]
      .filter((e) => e.childElementCount === 0 && e.textContent?.trim() && e.offsetParent !== null)
      .filter((e) => {
        const s = getComputedStyle(e);
        return s.overflowX === "hidden" && s.textOverflow !== "ellipsis" && e.scrollWidth > e.clientWidth + 1;
      })
      .map((e) => e.textContent!.trim().slice(0, 40)),
  );
  expect(clipped).toEqual([]);
});
