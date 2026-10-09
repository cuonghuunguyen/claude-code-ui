// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { matchesKey } from "./shortcuts.ts";
import { bind, bindingError, conflictOf, isChanged, parseOverrides, resetAll, resetBinding, specFromEvent, specOf, leavesTerminal } from "./keymap.ts";

const ev = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });

beforeEach(() => (localStorage.clear(), resetAll()));

it("an override wins, null disables, reset restores the default", () => {
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
  bind("sidebar.toggle", "mod+alt+b");
  expect(specOf("sidebar.toggle", false)).toBe("mod+alt+b");
  expect(isChanged("sidebar.toggle")).toBe(true);
  bind("sidebar.toggle", null);
  expect(specOf("sidebar.toggle", false)).toBeUndefined();
  resetBinding("sidebar.toggle");
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
  bind("file.open", "mod+o");
  resetAll();
  expect(specOf("file.open", false)).toBe("mod+p");
});

it("overrides are saved in localStorage", () => {
  bind("sidebar.toggle", "mod+alt+b");
  expect(JSON.parse(localStorage.getItem("claude-ui.keybindings")!)).toEqual({ "sidebar.toggle": "mod+alt+b" });
});

it("unknown ids and invalid specs are dropped on load; garbage gives no overrides", () => {
  expect(parseOverrides(JSON.stringify({ "sidebar.toggle": "mod+alt+b", nope: "mod+x", "file.open": "x", "tab.close": "mod+t", "panel.toggle": null, "leader": 5 }))).toEqual({ "sidebar.toggle": "mod+alt+b", "panel.toggle": null });
  expect(parseOverrides("{{")).toEqual({});
  expect(parseOverrides("[1]")).toEqual({});
  expect(parseOverrides(null)).toEqual({});
});

it("storage that throws leaves the defaults and does not break binding", () => {
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => bind("file.open", "mod+o")).not.toThrow();
  expect(specOf("file.open", false)).toBe("mod+o");
  set.mockRestore();
});

it("a plain key and a browser-reserved combo are rejected", () => {
  expect(bindingError("x")).toMatch(/Ctrl, Cmd or Alt/);
  expect(bindingError("shift+x")).toMatch(/Ctrl, Cmd or Alt/);
  expect(bindingError("mod+t", false)).toBe("The browser keeps this shortcut");
  expect(bindingError("mod+shift+t", false)).toBe("The browser keeps this shortcut");
  expect(bindingError("mod+3", false)).toBe("The browser keeps this shortcut");
  expect(bindingError("ctrl+tab", true)).toBe("The browser keeps this shortcut");
  expect(bindingError("ctrl+3", true)).toBeUndefined();
  expect(bindingError("alt+3", false)).toBeUndefined();
  expect(bindingError("mod+alt+b", false)).toBeUndefined();
  // A "dead" spec from an older build fires on every dead key: dropped on load.
  expect(bindingError("mod+alt+dead", false)).toBe("This key cannot be a shortcut");
  expect(parseOverrides(JSON.stringify({ "tab.close": "mod+alt+dead" }))).toEqual({});
});

it("a binding used by another shortcut is a conflict; the shortcut's own binding is not", () => {
  expect(conflictOf("sidebar.toggle", "mod+p", false)).toEqual({ id: "file.open", title: "Open file" });
  expect(conflictOf("file.open", "mod+p", false)).toBeUndefined();
  expect(conflictOf("sidebar.toggle", "mod+alt+b", false)).toBeUndefined();
  // A removed binding is free.
  bind("file.open", null);
  expect(conflictOf("sidebar.toggle", "mod+p", false)).toBeUndefined();
});

it("the prompt box format keys are conflicts, except Mod+B for the sidebar", () => {
  expect(conflictOf("file.open", "mod+i", false)?.title).toBe("Italic in the prompt box");
  expect(conflictOf("sidebar.toggle", "mod+b", false)).toBeUndefined();
});

it("the recorder turns a key press into a spec", () => {
  expect(specFromEvent(ev("b", { ctrlKey: true, altKey: true, code: "KeyB" }), false)).toBe("mod+alt+b");
  expect(specFromEvent(ev("Shift", { shiftKey: true }), false)).toBeUndefined();
  expect(specFromEvent(ev("+", { altKey: true, code: "Digit1" }), false)).toBe("alt+1");
  expect(specFromEvent(ev("∑", { metaKey: true, altKey: true, code: "KeyW" }), true)).toBe("mod+alt+w");
  expect(specFromEvent(ev("ArrowLeft", { ctrlKey: true, altKey: true }), false)).toBe("mod+alt+arrowleft");
  expect(specFromEvent(ev("l", { ctrlKey: true, code: "KeyL" }), true)).toBe("ctrl+l");
});

it("outside macOS the recorder stores the typed letter, so the matcher fires on the same press (QWERTZ, AZERTY, Dvorak)", () => {
  const presses: [string, string][] = [["z", "KeyY"], ["a", "KeyQ"], ["j", "KeyC"]];
  for (const [key, code] of presses) {
    const e = ev(key, { ctrlKey: true, shiftKey: true, code });
    const spec = specFromEvent(e, false)!;
    expect(spec).toBe(`mod+shift+${key}`);
    expect(matchesKey(spec, e, false)).toBe(true);
  }
  const alt = ev("w", { altKey: true, code: "KeyZ" });
  expect(specFromEvent(alt, false)).toBe("alt+w");
  expect(matchesKey("alt+w", alt, false)).toBe(true);
});

it("the conflict check compares the typed letter on QWERTZ", () => {
  bind("sidebar.toggle", "mod+shift+z");
  const spec = specFromEvent(ev("z", { ctrlKey: true, shiftKey: true, code: "KeyY" }), false)!;
  expect(conflictOf("panel.toggle", spec, false)?.id).toBe("sidebar.toggle");
});

it("terminal: tab keys, palette, terminal and prefix keys leave xterm; Ctrl+letter stays with the shell", () => {
  expect(leavesTerminal(ev("a", { altKey: true }))).toBe(true);
  expect(leavesTerminal(ev("2", { altKey: true, code: "Digit2" }))).toBe(true);
  expect(leavesTerminal(ev("`", { ctrlKey: true, code: "Backquote" }))).toBe(true);
  expect(leavesTerminal(ev("k", { ctrlKey: true }))).toBe(true);
  expect(leavesTerminal(ev("p", { ctrlKey: true }))).toBe(false);
  expect(leavesTerminal(ev("b", { ctrlKey: true }))).toBe(false);
  expect(leavesTerminal(ev("l", { ctrlKey: true }))).toBe(false);
});

it("AltGr, macOS Option and editing keys are refused as stored bindings and dropped on load", () => {
  expect(bindingError("mod+alt+[", false)).toMatch(/AltGr/);
  expect(parseOverrides('{"file.open":"mod+alt+["}')).toEqual({});
  expect(bindingError("mod+alt+[", true)).toBeUndefined();
  expect(bindingError("mod+alt++", false)).toBeUndefined();
  expect(bindingError("alt+l", true)).toMatch(/Option/);
  expect(bindingError("alt+f2", true)).toBeUndefined();
  expect(bindingError("ctrl+alt+l", true)).toBeUndefined();
  expect(bindingError("mod+v", false)).toMatch(/prompt box uses this key \(Paste\)/);
  expect(parseOverrides('{"file.open":"mod+v","tab.close":"mod+alt+b"}')).toEqual({ "tab.close": "mod+alt+b" });
});

it("the conflict check also compares the press: a spec string that differs can still fire on the same press", () => {
  // Hand-edited "alt++" would fire on Czech Alt+1 only through the old digit fallback; now it does not.
  bind("file.open", "alt++");
  const czechAlt1 = ev("+", { altKey: true, code: "Digit1" });
  expect(conflictOf("tab.goto1", "alt+1", false, czechAlt1)).toBeUndefined();
  const numpadPlus = ev("+", { altKey: true, code: "NumpadAdd" });
  expect(conflictOf("tab.goto1", "alt++", false, numpadPlus)?.id).toBe("file.open");
  // A QWERTZ press whose spec string differs from the bound one but fires on it.
  bind("sidebar.toggle", "mod+shift+z");
  const e = ev("Z", { ctrlKey: true, shiftKey: true, code: "KeyY" });
  expect(conflictOf("panel.toggle", "mod+shift+y", false, e)?.id).toBe("sidebar.toggle");
});

