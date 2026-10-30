// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { shownPrompt } from "./config-dialog.tsx";

beforeEach(() => Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body }));
afterEach(() => (document.body.innerHTML = ""));
const box = (html: string) => (document.body.innerHTML = html);

it("GH-356 with two splits the prompt of the active split is the shown prompt", () => {
  box('<div data-testid="split"><textarea data-prompt aria-label="Lời nhắc" id="a"></textarea></div><div data-testid="split" data-active><textarea data-prompt aria-label="Lời nhắc" id="b"></textarea></div>');
  expect(shownPrompt()?.id).toBe("b");
});

it("without a split the first visible prompt is the shown prompt", () => {
  box('<textarea data-prompt aria-label="Lời nhắc" id="a"></textarea><textarea data-prompt aria-label="Lời nhắc đầu tiên" id="b"></textarea>');
  expect(shownPrompt()?.id).toBe("a");
});

it("GH-356 an active split without a prompt box (permission panel, subagent view) has no shown prompt: never the other split's", () => {
  box('<div data-testid="split"><textarea data-prompt aria-label="Lời nhắc" id="a"></textarea></div><div data-testid="split" data-active><button>Allow</button></div>');
  expect(shownPrompt()).toBeNull();
});
