import { expect, it } from "vitest";
import { KEYS, keyLabels, matchesKey } from "./shortcuts.ts";

const ev = (key: string, init: KeyboardEventInit = {}) => ({ key, code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...init }) as KeyboardEvent;

it("mod is Ctrl off macOS and Cmd on macOS; other modifiers must match exactly", () => {
  expect(matchesKey("mod+k", ev("k", { ctrlKey: true }), false)).toBe(true);
  expect(matchesKey("mod+k", ev("k", { metaKey: true }), false)).toBe(false);
  expect(matchesKey("mod+k", ev("k", { metaKey: true }), true)).toBe(true);
  expect(matchesKey("mod+k", ev("k", { ctrlKey: true }), true)).toBe(false);
  expect(matchesKey("mod+k", ev("K", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  expect(matchesKey("mod+shift+p", ev("P", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
  expect(matchesKey("mod+p", ev("p", { ctrlKey: true, altKey: true }), false)).toBe(false);
  // Explicit ctrl stays Ctrl on macOS (OpenCode input.focus is ctrl+l).
  expect(matchesKey("ctrl+l", ev("l", { ctrlKey: true }), true)).toBe(true);
});

it("with Alt, letters match by physical key (macOS Option turns Option+W into ∑)", () => {
  expect(matchesKey("mod+alt+w", ev("∑", { metaKey: true, altKey: true, code: "KeyW" }), true)).toBe(true);
  expect(matchesKey("mod+alt+arrowright", ev("ArrowRight", { ctrlKey: true, altKey: true }), false)).toBe(true);
});

it("off macOS a letter matches by e.key only: AltGr (Ctrl+Alt) typing a character is not a shortcut", () => {
  // Hungarian layout: AltGr+W types "|".
  expect(matchesKey("mod+alt+w", ev("|", { ctrlKey: true, altKey: true, code: "KeyW" }), false)).toBe(false);
  expect(matchesKey("mod+alt+w", ev("w", { ctrlKey: true, altKey: true, code: "KeyW" }), false)).toBe(true);
});

it("Ctrl+P and Cmd+P are quick open, not Ctrl+Shift+P", () => {
  expect(matchesKey(KEYS.quickOpen, ev("p", { ctrlKey: true }), false)).toBe(true);
  expect(matchesKey(KEYS.quickOpen, ev("p", { metaKey: true }), true)).toBe(true);
  expect(matchesKey(KEYS.quickOpen, ev("P", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  expect(matchesKey(KEYS.quickOpen, ev("p"), false)).toBe(false);
});

it("labels each key for the palette's keybind chips", () => {
  expect(keyLabels("mod+shift+p", false)).toEqual(["Ctrl", "Shift", "P"]);
  expect(keyLabels("mod+shift+p", true)).toEqual(["⌘", "⇧", "P"]);
  expect(keyLabels("mod+alt+arrowleft", true)).toEqual(["⌘", "⌥", "←"]);
  expect(keyLabels("ctrl+l", true)).toEqual(["⌃", "L"]);
  expect(keyLabels("escape", false)).toEqual(["Esc"]);
  expect(keyLabels("mod+'", false)).toEqual(["Ctrl", "'"]);
});

it("every app shortcut needs Ctrl, Cmd or Alt, so typing in the prompt box never fires one", () => {
  for (const k of Object.values(KEYS)) expect(k).toMatch(/^(mod|ctrl|alt)\+/);
  // A plain or shifted letter matches none of them.
  for (const k of Object.values(KEYS)) for (const e of [ev("k"), ev("P", { shiftKey: true }), ev("'")]) expect(matchesKey(k, e, false)).toBe(false);
});
