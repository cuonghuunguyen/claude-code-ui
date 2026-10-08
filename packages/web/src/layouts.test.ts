// The recorder (keymap.ts specFromEvent) and the matcher (shortcuts.ts matchesKey) agree on every keyboard layout:
// a key press the recorder accepts fires the stored binding on the very same press. `key` is what Chrome reports for that press.
import { describe, expect, it } from "vitest";
import { bindingError, specFromEvent } from "./keymap.ts";
import { SHORTCUTS, defaultSpec, matchesKey } from "./shortcuts.ts";

type Press = { key: string; code: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
const ev = (p: Press) => ({ key: p.key, code: p.code, ctrlKey: !!p.ctrl, altKey: !!p.alt, shiftKey: !!p.shift, metaKey: !!p.meta, repeat: false }) as KeyboardEvent;
const C = { ctrl: true }, A = { alt: true }, S = { shift: true }, M = { meta: true };

/** [layout and press, macOS, the press, the stored spec]. */
const ACCEPTED: [string, boolean, Press, string][] = [
  // Windows and Linux: letters
  ["US Ctrl+Shift+Z", false, { key: "Z", code: "KeyZ", ...C, ...S }, "mod+shift+z"],
  ["QWERTZ Ctrl+Shift+Z", false, { key: "Z", code: "KeyY", ...C, ...S }, "mod+shift+z"],
  ["AZERTY Ctrl+Shift+A", false, { key: "A", code: "KeyQ", ...C, ...S }, "mod+shift+a"],
  ["AZERTY Alt+Z", false, { key: "z", code: "KeyW", ...A }, "alt+z"],
  ["Dvorak Ctrl+Shift+J", false, { key: "J", code: "KeyC", ...C, ...S }, "mod+shift+j"],
  ["Dvorak Ctrl+Alt+J", false, { key: "j", code: "KeyC", ...C, ...A }, "mod+alt+j"],
  ["Czech Ctrl+Shift+Z", false, { key: "Z", code: "KeyY", ...C, ...S }, "mod+shift+z"],
  ["Polish Alt+A", false, { key: "a", code: "KeyA", ...A }, "alt+a"],
  ["German Ctrl+Alt+B (no AltGr character)", false, { key: "b", code: "KeyB", ...C, ...A }, "mod+alt+b"],
  ["Russian Ctrl+Shift+Б", false, { key: "Б", code: "Comma", ...C, ...S }, "mod+shift+б"],
  ["Russian Alt+Л", false, { key: "л", code: "KeyK", ...A }, "alt+л"],
  ["Windows key+K", false, { key: "k", code: "KeyK", ...M }, "meta+k"],
  // Windows and Linux: digits
  ["US Ctrl+Shift+1 (!)", false, { key: "!", code: "Digit1", ...C, ...S }, "mod+shift+1"],
  ["US Ctrl+Alt+1", false, { key: "1", code: "Digit1", ...C, ...A }, "mod+alt+1"],
  ["German Ctrl+Alt+1 (no AltGr character)", false, { key: "1", code: "Digit1", ...C, ...A }, "mod+alt+1"],
  ["Czech Alt+1 (+)", false, { key: "+", code: "Digit1", ...A }, "alt+1"],
  ["Czech Ctrl+Shift+1", false, { key: "1", code: "Digit1", ...C, ...S }, "mod+shift+1"],
  ["AZERTY Alt+&", false, { key: "&", code: "Digit1", ...A }, "alt+1"],
  ["AZERTY Ctrl+Shift+1", false, { key: "1", code: "Digit1", ...C, ...S }, "mod+shift+1"],
  ["AZERTY Ctrl+Shift+É (2)", false, { key: "2", code: "Digit2", ...C, ...S }, "mod+shift+2"],
  ["Polish Alt+Shift+2 (@)", false, { key: "@", code: "Digit2", ...A, ...S }, "alt+shift+2"],
  ["Numpad Alt+5", false, { key: "5", code: "Numpad5", ...A }, "alt+5"],
  ["Numpad Ctrl+Alt+1, NumLock off", false, { key: "End", code: "Numpad1", ...C, ...A }, "mod+alt+end"],
  // Windows and Linux: the backquote key
  ["US Ctrl+`", false, { key: "`", code: "Backquote", ...C }, "mod+`"],
  ["US Ctrl+Shift+` (~)", false, { key: "~", code: "Backquote", ...C, ...S }, "mod+shift+`"],
  ["AZERTY Ctrl+²", false, { key: "²", code: "Backquote", ...C }, "mod+`"],
  ["AZERTY Ctrl+Shift+² (³)", false, { key: "³", code: "Backquote", ...C, ...S }, "mod+shift+`"],
  ["German Ctrl+^ (dead)", false, { key: "Dead", code: "Backquote", ...C }, "mod+`"],
  ["German Ctrl+Shift+°", false, { key: "°", code: "Backquote", ...C, ...S }, "mod+shift+`"],
  ["Czech Ctrl+;", false, { key: ";", code: "Backquote", ...C }, "mod+`"],
  ["Polish Alt+`", false, { key: "`", code: "Backquote", ...A }, "alt+`"],
  // Windows and Linux: punctuation and named keys
  ["US Ctrl+;", false, { key: ";", code: "Semicolon", ...C }, "mod+;"],
  ["US Ctrl+Shift+, (<)", false, { key: "<", code: "Comma", ...C, ...S }, "mod+shift+<"],
  ["US Ctrl+Shift+/ (?)", false, { key: "?", code: "Slash", ...C, ...S }, "mod+shift+?"],
  ["US Ctrl+Alt+/", false, { key: "/", code: "Slash", ...C, ...A }, "mod+alt+/"],
  ["German Ctrl+#", false, { key: "#", code: "Backslash", ...C }, "mod+#"],
  ["German Ctrl+-", false, { key: "-", code: "Slash", ...C }, "mod+-"],
  ["Czech Ctrl+Ú", false, { key: "ú", code: "BracketLeft", ...C }, "mod+ú"],
  ["Ctrl+Space", false, { key: " ", code: "Space", ...C }, "mod+space"],
  ["Alt+F2", false, { key: "F2", code: "F2", ...A }, "alt+f2"],
  // macOS: letters (Option changes `key`, so with Option the physical key)
  ["mac Option+W (∑)", true, { key: "∑", code: "KeyW", ...A }, "alt+w"],
  ["mac QWERTZ Cmd+Option+Z (Ω)", true, { key: "Ω", code: "KeyY", ...M, ...A }, "mod+alt+y"],
  ["mac AZERTY Option+A (æ)", true, { key: "æ", code: "KeyQ", ...A }, "alt+q"],
  ["mac Polish Option+A (ą)", true, { key: "ą", code: "KeyA", ...A }, "alt+a"],
  ["mac Option+E (dead ´)", true, { key: "Dead", code: "KeyE", ...A }, "alt+e"],
  ["mac German Ctrl+Option+L (@)", true, { key: "@", code: "KeyL", ...C, ...A }, "ctrl+alt+l"],
  ["mac QWERTZ Cmd+Shift+Z", true, { key: "z", code: "KeyY", ...M, ...S }, "mod+shift+z"],
  ["mac Dvorak Cmd+J", true, { key: "j", code: "KeyC", ...M }, "mod+j"],
  ["mac Russian Ctrl+Л", true, { key: "л", code: "KeyK", ...C }, "ctrl+л"],
  // macOS: digits and the backquote key
  ["mac US Ctrl+1", true, { key: "1", code: "Digit1", ...C }, "ctrl+1"],
  ["mac AZERTY Ctrl+&", true, { key: "&", code: "Digit1", ...C }, "ctrl+1"],
  ["mac Czech Ctrl+1 (+)", true, { key: "+", code: "Digit1", ...C }, "ctrl+1"],
  ["mac Slovak Ctrl+2 (ľ)", true, { key: "ľ", code: "Digit2", ...C }, "ctrl+2"],
  ["mac Option+1 (¡)", true, { key: "¡", code: "Digit1", ...A }, "alt+1"],
  ["mac German Cmd+Option+7 (¶)", true, { key: "¶", code: "Digit7", ...M, ...A }, "mod+alt+7"],
  ["mac AZERTY Ctrl+@ (backquote key)", true, { key: "@", code: "Backquote", ...C }, "ctrl+`"],
  ["mac AZERTY Cmd+Shift+@ (#)", true, { key: "#", code: "Backquote", ...M, ...S }, "mod+shift+`"],
  ["mac Option+` (dead)", true, { key: "Dead", code: "Backquote", ...A }, "alt+`"],
  // macOS: punctuation
  ["mac Cmd+;", true, { key: ";", code: "Semicolon", ...M }, "mod+;"],
  ["mac Cmd+Shift+/ (?)", true, { key: "?", code: "Slash", ...M, ...S }, "mod+shift+?"],
  ["mac Cmd+Option+, (≤)", true, { key: "≤", code: "Comma", ...M, ...A }, "mod+alt+≤"],
];

describe("a recorded binding fires on the same press", () => {
  it.each(ACCEPTED)("%s", (_, mac, p, spec) => {
    const e = ev(p);
    expect(specFromEvent(e, mac)).toBe(spec);
    expect(bindingError(spec, mac)).toBeUndefined();
    expect(matchesKey(spec, e, mac)).toBe(true);
  });
});

/** [layout and press, macOS, the press, the default shortcut it must run]. */
const DEFAULTS: [string, boolean, Press, string][] = [
  ["mac US Ctrl+1", true, { key: "1", code: "Digit1", ...C }, "tab.goto1"],
  ["mac AZERTY Ctrl+&", true, { key: "&", code: "Digit1", ...C }, "tab.goto1"],
  ["mac AZERTY Ctrl+ç (9)", true, { key: "ç", code: "Digit9", ...C }, "tab.gotoLast"],
  ["mac Czech Ctrl+1 (+)", true, { key: "+", code: "Digit1", ...C }, "tab.goto1"],
  ["mac Czech Ctrl+3 (š)", true, { key: "š", code: "Digit3", ...C }, "tab.goto3"],
  ["mac Belgian Ctrl+é (2)", true, { key: "é", code: "Digit2", ...C }, "tab.goto2"],
  ["Czech Alt+1 (+)", false, { key: "+", code: "Digit1", ...A }, "tab.goto1"],
  ["AZERTY Alt+&", false, { key: "&", code: "Digit1", ...A }, "tab.goto1"],
  ["AZERTY Ctrl+²", false, { key: "²", code: "Backquote", ...C }, "terminal.toggle"],
  ["German Ctrl+^ (dead)", false, { key: "Dead", code: "Backquote", ...C }, "terminal.toggle"],
  ["Czech Ctrl+;", false, { key: ";", code: "Backquote", ...C }, "terminal.toggle"],
  ["mac AZERTY Ctrl+@", true, { key: "@", code: "Backquote", ...C }, "terminal.toggle"],
  ["German Ctrl+Shift+°", false, { key: "°", code: "Backquote", ...C, ...S }, "terminal.new"],
  ["mac Option+A (å)", true, { key: "å", code: "KeyA", ...A }, "leader"],
  ["mac Cmd+Option+W (∑)", true, { key: "∑", code: "KeyW", ...M, ...A }, "tab.close"],
];

describe("a default shortcut fires on its key on every layout", () => {
  it.each(DEFAULTS)("%s", (_, mac, p, id) => {
    const s = SHORTCUTS.find((x) => x.id === id)!;
    expect(matchesKey(defaultSpec(s, mac), ev(p), mac)).toBe(true);
  });
});
