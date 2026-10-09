// The recorder (keymap.ts specFromEvent) and the matcher (shortcuts.ts matchesKey) agree on every keyboard layout:
// a key press the recorder accepts fires the stored binding on the very same press. `key` is what Chrome reports for that press.
import { describe, expect, it } from "vitest";
import { bindingError, pressError, specFromEvent } from "./keymap.ts";
import { SHORTCUTS, canon, defaultSpec, matchesKey } from "./shortcuts.ts";

type Press = { key: string; code: string; ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };
const ev = (p: Press) => ({ key: p.key, code: p.code, ctrlKey: !!p.ctrl, altKey: !!p.alt, shiftKey: !!p.shift, metaKey: !!p.meta, repeat: false }) as KeyboardEvent;
const C = { ctrl: true }, A = { alt: true }, S = { shift: true }, M = { meta: true };

/** [layout and press, macOS, the press, the stored spec]. */
const ACCEPTED: [string, boolean, Press, string][] = [
  // Windows and Linux: letters
  ["US Ctrl+Shift+Y", false, { key: "Y", code: "KeyY", ...C, ...S }, "mod+shift+y"],
  ["QWERTZ Ctrl+Shift+Y", false, { key: "Y", code: "KeyZ", ...C, ...S }, "mod+shift+y"],
  ["AZERTY Ctrl+Shift+A", false, { key: "A", code: "KeyQ", ...C, ...S }, "mod+shift+a"],
  ["AZERTY Alt+Z", false, { key: "z", code: "KeyW", ...A }, "alt+z"],
  ["Dvorak Ctrl+Shift+J", false, { key: "J", code: "KeyC", ...C, ...S }, "mod+shift+j"],
  ["Dvorak Ctrl+Alt+J", false, { key: "j", code: "KeyC", ...C, ...A }, "mod+alt+j"],
  ["Czech Ctrl+Shift+Y", false, { key: "Y", code: "KeyZ", ...C, ...S }, "mod+shift+y"],
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
  ["Numpad Ctrl+Alt+5", false, { key: "5", code: "Numpad5", ...C, ...A }, "mod+alt+5"],
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
  ["German Ctrl+#", false, { key: "#", code: "Backslash", ...C }, "mod+#"],
  ["German Ctrl+-", false, { key: "-", code: "Slash", ...C }, "mod+-"],
  ["Czech Ctrl+Ú", false, { key: "ú", code: "BracketLeft", ...C }, "mod+ú"],
  ["Ctrl+Space", false, { key: " ", code: "Space", ...C }, "mod+space"],
  ["Alt+F2", false, { key: "F2", code: "F2", ...A }, "alt+f2"],
  // The + key: "mod++" is Ctrl and the + key
  ["German Ctrl+Plus", false, { key: "+", code: "BracketRight", ...C }, "mod++"],
  ["US Ctrl+Shift+= (+)", false, { key: "+", code: "Equal", ...C, ...S }, "mod+shift++"],
  ["Numpad Ctrl+Alt++", false, { key: "+", code: "NumpadAdd", ...C, ...A }, "mod+alt++"],
  ["Numpad Alt++", false, { key: "+", code: "NumpadAdd", ...A }, "alt++"],
  ["mac German Cmd+Plus", true, { key: "+", code: "BracketRight", ...M }, "mod++"],
  ["mac US Cmd+Shift+= (+)", true, { key: "+", code: "Equal", ...M, ...S }, "mod+shift++"],
  // macOS: letters (Option changes `key`, so with Option the physical key)
  ["mac QWERTZ Cmd+Option+Z (Ω)", true, { key: "Ω", code: "KeyY", ...M, ...A }, "mod+alt+y"],
  ["mac German Ctrl+Option+L (@)", true, { key: "@", code: "KeyL", ...C, ...A }, "ctrl+alt+l"],
  ["mac QWERTZ Cmd+Shift+Y", true, { key: "y", code: "KeyZ", ...M, ...S }, "mod+shift+y"],
  ["mac Dvorak Cmd+J", true, { key: "j", code: "KeyC", ...M }, "mod+j"],
  ["mac Russian Ctrl+Л", true, { key: "л", code: "KeyK", ...C }, "ctrl+л"],
  // macOS: digits and the backquote key
  ["mac US Ctrl+1", true, { key: "1", code: "Digit1", ...C }, "ctrl+1"],
  ["mac AZERTY Ctrl+&", true, { key: "&", code: "Digit1", ...C }, "ctrl+1"],
  ["mac Czech Ctrl+1 (+)", true, { key: "+", code: "Digit1", ...C }, "ctrl+1"],
  ["mac Slovak Ctrl+2 (ľ)", true, { key: "ľ", code: "Digit2", ...C }, "ctrl+2"],
  ["mac German Cmd+Option+7 (¶)", true, { key: "¶", code: "Digit7", ...M, ...A }, "mod+alt+7"],
  ["mac AZERTY Ctrl+@ (backquote key)", true, { key: "@", code: "Backquote", ...C }, "ctrl+`"],
  ["mac AZERTY Cmd+Shift+@ (#)", true, { key: "#", code: "Backquote", ...M, ...S }, "mod+shift+`"],
  // macOS: punctuation
  ["mac Cmd+;", true, { key: ";", code: "Semicolon", ...M }, "mod+;"],
  ["mac Cmd+Shift+/ (?)", true, { key: "?", code: "Slash", ...M, ...S }, "mod+shift+?"],
  ["mac Option+F2", true, { key: "F2", code: "F2", ...A }, "alt+f2"],
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
  ["US Alt+1 (top row)", false, { key: "1", code: "Digit1", ...A }, "tab.goto1"],
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

/** Off macOS Ctrl+Alt is AltGr: [layout and press, the press]. Each types a character (or starts an accent), so it is no shortcut. */
const ALTGR: [string, Press][] = [
  ["German AltGr+Q (@)", { key: "@", code: "KeyQ", ...C, ...A }],
  ["German AltGr+E (€)", { key: "€", code: "KeyE", ...C, ...A }],
  ["German AltGr+M (µ)", { key: "µ", code: "KeyM", ...C, ...A }],
  ["German AltGr+7 ({)", { key: "{", code: "Digit7", ...C, ...A }],
  ["German AltGr+0 (})", { key: "}", code: "Digit0", ...C, ...A }],
  ["German AltGr+ß (\)", { key: "\\", code: "Minus", ...C, ...A }],
  ["German AltGr+Plus (~)", { key: "~", code: "BracketRight", ...C, ...A }],
  ["German AltGr+< (|)", { key: "|", code: "IntlBackslash", ...C, ...A }],
  ["Polish AltGr+A (ą)", { key: "ą", code: "KeyA", ...C, ...A }],
  ["Polish AltGr+Shift+A (Ą)", { key: "Ą", code: "KeyA", ...C, ...A, ...S }],
  ["Polish AltGr+L (ł)", { key: "ł", code: "KeyL", ...C, ...A }],
  ["Hungarian AltGr+W (|)", { key: "|", code: "KeyW", ...C, ...A }],
  ["Czech AltGr+, (<)", { key: "<", code: "Comma", ...C, ...A }],
  ["Czech AltGr+F ([)", { key: "[", code: "KeyF", ...C, ...A }],
  ["Czech AltGr+ů ($)", { key: "$", code: "Semicolon", ...C, ...A }],
  ["AZERTY AltGr+à (@)", { key: "@", code: "Digit0", ...C, ...A }],
  ["AZERTY AltGr+\" (#)", { key: "#", code: "Digit3", ...C, ...A }],
  ["Spanish AltGr+º (\)", { key: "\\", code: "Backquote", ...C, ...A }],
  ["Czech AltGr+2 (dead ˇ)", { key: "Dead", code: "Digit2", ...C, ...A }],
  ["Czech AltGr+= (dead ´)", { key: "Dead", code: "Equal", ...C, ...A }],
  // The AltGr character is the key's US character: Ctrl+Alt is still AltGr.
  ["Spanish AltGr+` ([)", { key: "[", code: "BracketLeft", ...C, ...A }],
  ["Spanish AltGr++ (])", { key: "]", code: "BracketRight", ...C, ...A }],
  ["Italian AltGr+è ([)", { key: "[", code: "BracketLeft", ...C, ...A }],
  ["Italian AltGr++ (])", { key: "]", code: "BracketRight", ...C, ...A }],
  ["Italian AltGr+Shift+è ({)", { key: "{", code: "BracketLeft", ...C, ...A, ...S }],
  ["Italian AltGr+Shift++ (})", { key: "}", code: "BracketRight", ...C, ...A, ...S }],
  ["Swiss German AltGr+ü ([)", { key: "[", code: "BracketLeft", ...C, ...A }],
  ["Swiss German AltGr+¨ (])", { key: "]", code: "BracketRight", ...C, ...A }],
  ["Belgian AltGr+^ ([)", { key: "[", code: "BracketLeft", ...C, ...A }],
  ["Belgian AltGr+$ (])", { key: "]", code: "BracketRight", ...C, ...A }],
  ["US Ctrl+Alt+/ (no AltGr character, refused)", { key: "/", code: "Slash", ...C, ...A }],
  // The base character of a non-US key: Ctrl+Alt cannot be told apart from AltGr here, so it is refused too.
  ["AZERTY Ctrl+Alt+& (no AltGr character)", { key: "&", code: "Digit1", ...C, ...A }],
  ["Russian Ctrl+Alt+Л", { key: "л", code: "KeyK", ...C, ...A }],
];

describe("AltGr (Ctrl+Alt off macOS) typing a character is never a shortcut", () => {
  it.each(ALTGR)("%s: the recorder refuses it", (_, p) => {
    expect(pressError(ev(p), false)).toMatch(/AltGr/);
  });
  it.each(ALTGR)("%s: no default and no recordable binding fires on it", (_, p) => {
    const specs = [...SHORTCUTS.map((s) => defaultSpec(s, false)), ...ACCEPTED.filter(([, mac]) => !mac).map(([, , , spec]) => spec)];
    // Bindings made on a US keyboard for the same key: Ctrl+Alt+Q, +7, +ß's key (-), +, (comma), +A.
    specs.push("mod+alt+q", "mod+alt+7", "mod+alt+-", "mod+alt+,", "mod+alt+a", "mod+alt+@", "mod+alt+ą", "mod+alt+\\", "mod+alt+<", "mod+alt+[", "mod+alt+]", "mod+alt+shift+{", "mod+alt+shift+}", "mod+alt+/");
    for (const spec of specs) expect(matchesKey(spec, ev(p), false), spec).toBe(false);
  });
  it("on macOS Ctrl+Option is no AltGr: the press is a shortcut", () => {
    expect(pressError(ev({ key: "@", code: "KeyL", ...C, ...A }), true)).toBeUndefined();
  });
  it("accepted presses have no error", () => {
    for (const [name, mac, p] of ACCEPTED) expect(pressError(ev(p), mac), name).toBeUndefined();
  });
});

/** Presses whose key the browser does not name: [layout and press, macOS, the press]. A binding on them would fire on any dead key, so they are refused. */
const UNNAMED: [string, boolean, Press][] = [
  ["Czech Ctrl+´ (dead)", false, { key: "Dead", code: "Equal", ...C }],
  ["US International Alt+' (dead)", false, { key: "Dead", code: "Quote", ...A }],
  ["German Ctrl+´ (dead)", false, { key: "Dead", code: "Equal", ...C }],
  ["mac German Cmd+´ (dead)", true, { key: "Dead", code: "Equal", ...M }],
  ["mac Czech Ctrl+´ (dead)", true, { key: "Dead", code: "Equal", ...C }],
  ["an unidentified key", false, { key: "Unidentified", code: "", ...C }],
  ["a key while an input method composes", false, { key: "Process", code: "KeyA", ...C }],
];

describe("dead and unnamed keys are refused, not stored as \"dead\"", () => {
  it.each(UNNAMED)("%s", (_, mac, p) => {
    expect(pressError(ev(p), mac)).toMatch(/dead key|does not say which key/);
  });
});

/** macOS Option (+Shift) without Cmd or Ctrl types a character: [layout and press, the press]. */
const MAC_OPTION: [string, Press][] = [
  ["German Option+L (@)", { key: "@", code: "KeyL", ...A }],
  ["German Option+5 ([)", { key: "[", code: "Digit5", ...A }],
  ["German Option+8 ({)", { key: "{", code: "Digit8", ...A }],
  ["German Option+7 (|)", { key: "|", code: "Digit7", ...A }],
  ["Polish Option+A (ą)", { key: "ą", code: "KeyA", ...A }],
  ["Polish Option+S (ś)", { key: "ś", code: "KeyS", ...A }],
  ["Polish Option+Z (ż)", { key: "ż", code: "KeyZ", ...A }],
  ["US Option+W (∑)", { key: "∑", code: "KeyW", ...A }],
  ["US Option+Shift+W („)", { key: "„", code: "KeyW", ...A, ...S }],
  ["US Option+E (dead)", { key: "Dead", code: "KeyE", ...A }],
  ["US Option+` (dead)", { key: "Dead", code: "Backquote", ...A }],
  ["US Option+1 (¡)", { key: "¡", code: "Digit1", ...A }],
  ["US Option+Space (no-break space)", { key: " ", code: "Space", ...A }],
];

describe("macOS Option without Cmd or Ctrl types a character: the recorder refuses it", () => {
  it.each(MAC_OPTION)("%s", (_, p) => {
    expect(pressError(ev(p), true)).toMatch(/Option/);
  });
  it("the stored spec is refused too, and named keys and Cmd or Ctrl with Option stay allowed", () => {
    expect(bindingError("alt+l", true)).toMatch(/Option/);
    expect(bindingError("alt+shift+w", true)).toMatch(/Option/);
    expect(bindingError("alt+space", true)).toMatch(/Option/);
    expect(bindingError("alt+l", false)).toBeUndefined();
    expect(pressError(ev({ key: "F2", code: "F2", ...A }), true)).toBeUndefined();
    expect(specFromEvent(ev({ key: "F2", code: "F2", ...A }), true)).toBe("alt+f2");
  });
});

/** Windows Alt codes (Alt+0169 is ©): [the press]. */
const ALT_CODES: [string, Press][] = [
  ["Alt+Numpad0", { key: "0", code: "Numpad0", ...A }],
  ["Alt+Numpad1", { key: "1", code: "Numpad1", ...A }],
  ["Alt+Numpad6", { key: "6", code: "Numpad6", ...A }],
  ["Alt+Numpad9", { key: "9", code: "Numpad9", ...A }],
  ["Alt+Shift+Numpad1", { key: "1", code: "Numpad1", ...A, ...S }],
];

/** The specs every press is checked against: all defaults and all recordable bindings of the platform. */
const specsOf = (mac: boolean) => [...SHORTCUTS.map((s) => defaultSpec(s, mac)), ...ACCEPTED.filter(([, m]) => m === mac).map(([, , , spec]) => spec)];

describe("Alt+number pad digits are a Windows Alt code, not a shortcut", () => {
  it.each(ALT_CODES)("%s: the recorder refuses it", (_, p) => {
    expect(pressError(ev(p), false)).toMatch(/character code/);
  });
  it.each(ALT_CODES)("%s: no default and no recordable binding fires on it", (_, p) => {
    const specs = [...specsOf(false), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`alt+${n}`, `alt+shift+${n}`])];
    for (const spec of specs) expect(matchesKey(spec, ev(p), false), spec).toBe(false);
  });
});

/** One press, one binding: [name, macOS, the press, the spec it fires, a spec it must not fire]. */
const SAME_PRESS: [string, boolean, Press, string, string][] = [
  ["Czech Alt+1 (+)", false, { key: "+", code: "Digit1", ...A }, "alt+1", "alt++"],
  ["Czech Alt+Numpad+", false, { key: "+", code: "NumpadAdd", ...A }, "alt++", "alt+1"],
  ["AZERTY Alt+6 (-)", false, { key: "-", code: "Digit6", ...A }, "alt+6", "alt+-"],
  ["German Ctrl+Shift+7 (/)", false, { key: "/", code: "Digit7", ...C, ...S }, "mod+shift+7", "mod+shift+/"],
  ["German Ctrl+Shift+Numpad/", false, { key: "/", code: "NumpadDivide", ...C, ...S }, "mod+shift+/", "mod+shift+7"],
  ["US Ctrl+Shift+8 (*)", false, { key: "*", code: "Digit8", ...C, ...S }, "mod+shift+8", "mod+shift+*"],
  ["Hungarian Ctrl+0 key (Backquote)", false, { key: "0", code: "Backquote", ...C }, "mod+`", "mod+0"],
  ["Numpad1, NumLock off", false, { key: "End", code: "Numpad1", ...C, ...A }, "mod+alt+end", "mod+alt+1"],
];

describe("one press fires at most one binding", () => {
  it.each(SAME_PRESS)("%s", (_, mac, p, fires, not) => {
    expect(matchesKey(fires, ev(p), mac)).toBe(true);
    expect(matchesKey(not, ev(p), mac)).toBe(false);
  });
  it("every press of every table matches at most one distinct spec of the defaults and the recordable bindings", () => {
    const presses: [string, boolean, Press][] = [
      ...ACCEPTED.map(([n, m, p]): [string, boolean, Press] => [n, m, p]),
      ...DEFAULTS.map(([n, m, p]): [string, boolean, Press] => [n, m, p]),
      ...ALT_CODES.map(([n, p]): [string, boolean, Press] => [n, false, p]),
      ...ALTGR.map(([n, p]): [string, boolean, Press] => [n, false, p]),
      ...MAC_OPTION.map(([n, p]): [string, boolean, Press] => [n, true, p]),
      ...SAME_PRESS.map(([n, m, p]): [string, boolean, Press] => [n, m, p]),
    ];
    for (const [name, mac, p] of presses) {
      const hit = [...new Set(specsOf(mac).filter((s) => matchesKey(s, ev(p), mac)).map((s) => canon(s, mac)))];
      expect([name, hit]).toEqual([name, hit.slice(0, 1)]);
    }
  });
});

/** Prompt box editing keys: [name, macOS, the press, the spec it records]. The recorder refuses them. */
const EDITING_PRESSES: [string, boolean, Press, string][] = [
  ["Ctrl+V", false, { key: "v", code: "KeyV", ...C }, "mod+v"],
  ["Ctrl+C", false, { key: "c", code: "KeyC", ...C }, "mod+c"],
  ["Ctrl+X", false, { key: "x", code: "KeyX", ...C }, "mod+x"],
  ["Ctrl+Z", false, { key: "z", code: "KeyZ", ...C }, "mod+z"],
  ["QWERTZ Ctrl+Z (key z, code KeyY)", false, { key: "z", code: "KeyY", ...C }, "mod+z"],
  ["Ctrl+Shift+Z", false, { key: "Z", code: "KeyZ", ...C, ...S }, "mod+shift+z"],
  ["Ctrl+Y", false, { key: "y", code: "KeyY", ...C }, "mod+y"],
  ["Ctrl+A", false, { key: "a", code: "KeyA", ...C }, "mod+a"],
  ["Ctrl+Backspace", false, { key: "Backspace", code: "Backspace", ...C }, "mod+backspace"],
  ["Ctrl+Delete", false, { key: "Delete", code: "Delete", ...C }, "mod+delete"],
  ["Ctrl+ArrowLeft", false, { key: "ArrowLeft", code: "ArrowLeft", ...C }, "mod+arrowleft"],
  ["Ctrl+Shift+ArrowRight", false, { key: "ArrowRight", code: "ArrowRight", ...C, ...S }, "mod+shift+arrowright"],
  ["Ctrl+Home", false, { key: "Home", code: "Home", ...C }, "mod+home"],
  ["mac Cmd+V", true, { key: "v", code: "KeyV", ...M }, "mod+v"],
  ["mac Cmd+Z", true, { key: "z", code: "KeyZ", ...M }, "mod+z"],
  ["mac Cmd+Shift+Z", true, { key: "Z", code: "KeyZ", ...M, ...S }, "mod+shift+z"],
  ["mac Cmd+Backspace", true, { key: "Backspace", code: "Backspace", ...M }, "mod+backspace"],
  ["mac Cmd+ArrowLeft", true, { key: "ArrowLeft", code: "ArrowLeft", ...M }, "mod+arrowleft"],
  ["mac Option+Backspace", true, { key: "Backspace", code: "Backspace", ...A }, "alt+backspace"],
  ["mac Option+ArrowLeft", true, { key: "ArrowLeft", code: "ArrowLeft", ...A }, "alt+arrowleft"],
  ["mac Option+Shift+ArrowRight", true, { key: "ArrowRight", code: "ArrowRight", ...A, ...S }, "alt+shift+arrowright"],
];

describe("the prompt box's editing keys cannot be bound", () => {
  it.each(EDITING_PRESSES)("%s", (_, mac, p, spec) => {
    expect(specFromEvent(ev(p), mac)).toBe(spec);
    expect(bindingError(spec, mac)).toMatch(/prompt box uses/);
  });
  it("Ctrl+Alt+ArrowLeft is not an editing key", () => {
    expect(bindingError("mod+alt+arrowleft", false)).toBeUndefined();
    expect(bindingError("mod+alt+arrowleft", true)).toBeUndefined();
  });
});

describe("every default passes the binding rules", () => {
  it.each([false, true])("macOS %s", (mac) => {
    // The macOS prefix key Option+A is a default, not a binding: it types å, and the recorder refuses it for a user's own binding (Reset restores it).
    for (const s of SHORTCUTS) if (!(mac && s.id === "leader")) expect([s.id, bindingError(defaultSpec(s, mac), mac)]).toEqual([s.id, undefined]);
    expect(bindingError("alt+a", true)).toMatch(/Option/);
  });
});
