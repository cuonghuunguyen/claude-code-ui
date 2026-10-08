// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TERMINAL_FONT, loadTerminalFont, resetTerminalFont, terminalFontSettled } from "./terminal-font.ts";

const setFonts = (load: unknown) => Object.defineProperty(document, "fonts", { value: { load }, configurable: true });

beforeEach(() => resetTerminalFont());
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "fonts");
});

it("puts the Nerd Font symbols after the text families and before the generic monospace", () => {
  const families = TERMINAL_FONT.split(",").map((f) => f.trim().replaceAll('"', ""));
  expect(families.slice(0, 5)).toEqual(["ui-monospace", "JetBrains Mono", "SFMono-Regular", "Menlo", "Consolas"]);
  expect(families.at(-2)).toBe("Symbols Nerd Font Mono");
  expect(families.at(-1)).toBe("monospace");
});

it("loads the symbols font once with a private-use sample, however often it is asked", async () => {
  const load = vi.fn(async () => []);
  setFonts(load);
  await Promise.all([loadTerminalFont(), loadTerminalFont()]);
  await loadTerminalFont();
  expect(load).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledWith('14px "Symbols Nerd Font Mono"', "\ue0a0");
});

it("resolves when the load fails or the browser has no font API", async () => {
  setFonts(vi.fn(async () => Promise.reject(new Error("404"))));
  await expect(loadTerminalFont()).resolves.toBeUndefined();
  resetTerminalFont();
  Reflect.deleteProperty(document, "fonts");
  await expect(loadTerminalFont()).resolves.toBeUndefined();
});

it("stops waiting after 3 s when the load never settles, terminalFontSettled follows the real load", async () => {
  vi.useFakeTimers();
  let done!: () => void;
  setFonts(() => new Promise<void>((r) => (done = r)));
  let waited = false;
  void loadTerminalFont().then(() => (waited = true));
  let settled = false;
  void terminalFontSettled().then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(2900);
  expect(waited).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(waited).toBe(true);
  expect(settled).toBe(false);
  done();
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
});
