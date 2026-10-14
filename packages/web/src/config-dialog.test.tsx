// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { shownPrompt } from "./config-dialog.tsx";

afterEach(() => (document.body.innerHTML = ""));
const box = (html: string) => (document.body.innerHTML = html);

it("GH-356 with two splits the prompt of the active split is the shown prompt", () => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
  box('<div data-testid="split"><textarea aria-label="Prompt" id="a"></textarea></div><div data-testid="split" data-active><textarea aria-label="Prompt" id="b"></textarea></div>');
  expect(shownPrompt()?.id).toBe("b");
});

it("without a split the first visible prompt is the shown prompt", () => {
  box('<textarea aria-label="Prompt" id="a"></textarea><textarea aria-label="First prompt" id="b"></textarea>');
  expect(shownPrompt()?.id).toBe("a");
});
