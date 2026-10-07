import { expect, it } from "vitest";
import { isImeKey } from "./ime.ts";

it("isImeKey: isComposing or keyCode 229 belongs to the IME; a plain Enter does not", () => {
  expect(isImeKey({ isComposing: true, keyCode: 13 })).toBe(true);
  expect(isImeKey({ isComposing: false, keyCode: 229 })).toBe(true);
  expect(isImeKey({ isComposing: false, keyCode: 13 })).toBe(false);
  expect(isImeKey({})).toBe(false);
});
