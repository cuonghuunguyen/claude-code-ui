import { expect, it } from "vitest";
import { KEYS, SHORTCUTS, canon, defaultSpec, keyLabels, matchesKey } from "./shortcuts.ts";
import { bindingError } from "./keymap.ts";

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
  expect(matchesKey(KEYS["file.open"], ev("p", { ctrlKey: true }), false)).toBe(true);
  expect(matchesKey(KEYS["file.open"], ev("p", { metaKey: true }), true)).toBe(true);
  expect(matchesKey(KEYS["file.open"], ev("P", { ctrlKey: true, shiftKey: true }), false)).toBe(false);
  expect(matchesKey(KEYS["file.open"], ev("p"), false)).toBe(false);
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
  for (const s of SHORTCUTS) for (const mac of [false, true]) expect(defaultSpec(s, mac)).toMatch(/^(mod|ctrl|alt)\+/);
  // A plain or shifted letter matches none of them.
  for (const k of Object.values(KEYS)) for (const e of [ev("k"), ev("P", { shiftKey: true }), ev("'")]) expect(matchesKey(k, e, false)).toBe(false);
});

it("Alt+digit matches by physical key: Czech Alt+1 types \"+\"", () => {
  expect(matchesKey("alt+1", ev("+", { altKey: true, code: "Digit1" }), false)).toBe(true);
  expect(matchesKey("alt+1", ev("1", { altKey: true, code: "Digit1" }), false)).toBe(true);
  expect(matchesKey("alt+2", ev("+", { altKey: true, code: "Digit1" }), false)).toBe(false);
  expect(matchesKey("ctrl+1", ev("1", { ctrlKey: true, code: "Digit1" }), true)).toBe(true);
  expect(matchesKey("alt+1", ev("1", { code: "Digit1" }), false)).toBe(false);
  // Shift+` is "~" on a US layout.
  expect(matchesKey("ctrl+shift+`", ev("~", { ctrlKey: true, shiftKey: true, code: "Backquote" }), false)).toBe(true);
  expect(matchesKey("ctrl+`", ev("`", { ctrlKey: true, code: "Backquote" }), false)).toBe(true);
});

it("registry: ids are unique, no default is browser-reserved, no two defaults collide per platform", () => {
  expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
  for (const mac of [false, true]) {
    const specs = SHORTCUTS.map((s) => canon(defaultSpec(s, mac), mac));
    expect(new Set(specs).size).toBe(specs.length);
    for (const s of SHORTCUTS) expect(bindingError(defaultSpec(s, mac), mac)).toBeUndefined();
  }
});

it("tab-by-number defaults: Alt+1..8 and Alt+9 (last) off macOS, Ctrl on macOS", () => {
  const goto = (id: string, mac: boolean) => defaultSpec(SHORTCUTS.find((s) => s.id === id)!, mac);
  expect(goto("tab.goto3", false)).toBe("alt+3");
  expect(goto("tab.goto3", true)).toBe("ctrl+3");
  expect(goto("tab.gotoLast", false)).toBe("alt+9");
});

it("canon resolves mod and orders modifiers", () => {
  expect(canon("mod+shift+p", false)).toBe("ctrl+shift+p");
  expect(canon("shift+mod+p", true)).toBe("meta+shift+p");
  expect(canon("alt+shift+t", false)).toBe(canon("shift+alt+t", false));
});

it("a digit never matches by code while Ctrl and Alt are both down (AltGr on Windows)", () => {
  const altGr = ev("{", { code: "Digit7", ctrlKey: true, altKey: true });
  expect(matchesKey("mod+alt+7", altGr, false)).toBe(false);
  // Alt alone still matches by the physical key (Czech Alt+1 types "+").
  expect(matchesKey("alt+1", ev("+", { code: "Digit1", altKey: true }), false)).toBe(true);
});

it("the + key: \"mod++\" is Ctrl and +, \"mod+shift++\" is Ctrl, Shift and +", () => {
  expect(matchesKey("mod++", ev("+", { ctrlKey: true, code: "BracketRight" }), false)).toBe(true);
  expect(matchesKey("mod++", ev("=", { ctrlKey: true, code: "Equal" }), false)).toBe(false);
  expect(matchesKey("mod+shift++", ev("+", { ctrlKey: true, shiftKey: true, code: "Equal" }), false)).toBe(true);
  expect(matchesKey("mod++", ev("+", { ctrlKey: true, shiftKey: true, code: "Equal" }), false)).toBe(false);
  expect(canon("mod+shift++", false)).toBe("ctrl+shift++");
  expect(keyLabels("mod+shift++", false)).toEqual(["Ctrl", "Shift", "+"]);
  expect(bindingError("mod++", false)).toBeUndefined();
  expect(bindingError("shift++", false)).toMatch(/Ctrl, Cmd or Alt/);
});
