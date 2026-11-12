import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEYS, SHORTCUTS, canon, defaultSpec, keyLabels, matchesKey, withKey } from "./shortcuts.ts";
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

it("Ctrl+Shift+F and Cmd+Shift+F are Find in files, not plain Ctrl+F", () => {
  expect(matchesKey(KEYS["find.files"], ev("F", { ctrlKey: true, shiftKey: true }), false)).toBe(true);
  expect(matchesKey(KEYS["find.files"], ev("F", { metaKey: true, shiftKey: true }), true)).toBe(true);
  expect(matchesKey(KEYS["find.files"], ev("f", { ctrlKey: true }), false)).toBe(false);
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
  for (const s of SHORTCUTS.filter((x) => x.key)) for (const mac of [false, true]) expect(defaultSpec(s, mac)).toMatch(/^(mod|ctrl|alt)\+/);
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
    const specs = SHORTCUTS.filter((s) => s.key).map((s) => canon(defaultSpec(s, mac)!, mac));
    expect(new Set(specs).size).toBe(specs.length);
    // The macOS prefix key Option+A is the one default the recorder would refuse for a user's own binding (it types å).
    for (const s of SHORTCUTS) if (s.key && !(mac && s.id === "leader")) expect(bindingError(defaultSpec(s, mac)!, mac)).toBeUndefined();
  }
});

it("Go to notifications is Ctrl/Cmd+Alt+N: a modifier, not Escape, no clash (GH-158)", () => {
  const spec = KEYS["notifications.focus"]!;
  expect(spec).toBe("mod+alt+n");
  expect(spec).not.toMatch(/escape/);
  expect(SHORTCUTS.filter((s) => s.key && canon(defaultSpec(s)!) === canon(spec))).toHaveLength(1);
  expect(bindingError(spec)).toBeUndefined();
  expect(matchesKey(spec, ev("n", { ctrlKey: true, altKey: true }), false)).toBe(true);
  // A Polish AltGr+N types "ń": typing, not the shortcut.
  expect(matchesKey(spec, ev("ń", { ctrlKey: true, altKey: true, code: "KeyN" }), false)).toBe(false);
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

it("a button hint names its key, and is the bare label when the binding is removed", () => {
  expect(withKey("New terminal", "ctrl+shift+`")).toMatch(/^New terminal \(.+\)$/);
  expect(withKey("New terminal", undefined)).toBe("New terminal");
});

it("Alt+number pad digits (a Windows Alt code) fire no shortcut off macOS; the top row and macOS are unchanged", () => {
  expect(matchesKey("alt+1", ev("1", { altKey: true, code: "Numpad1" }), false)).toBe(false);
  expect(matchesKey("alt+1", ev("1", { altKey: true, code: "Digit1" }), false)).toBe(true);
  expect(matchesKey("ctrl+1", ev("1", { ctrlKey: true, code: "Numpad1" }), true)).toBe(true);
  expect(matchesKey("mod+alt+5", ev("5", { ctrlKey: true, altKey: true, code: "Numpad5" }), false)).toBe(true);
});

it("a digit or ` press matches only the spec of its physical key", () => {
  expect(matchesKey("alt++", ev("+", { altKey: true, code: "Digit1" }), false)).toBe(false);
  expect(matchesKey("mod+0", ev("0", { ctrlKey: true, code: "Backquote" }), false)).toBe(false);
  expect(matchesKey("mod+`", ev("0", { ctrlKey: true, code: "Backquote" }), false)).toBe(true);
});

it("unbound registry commands have no default and no KEYS entry", () => {
  for (const id of ["focus.open", "guide.start", "mcp.open", "skills.open", "plugins.open"]) {
    const s = SHORTCUTS.find((x) => x.id === id)!;
    expect(defaultSpec(s, false)).toBeUndefined();
    expect(defaultSpec(s, true)).toBeUndefined();
    expect(id in KEYS).toBe(false);
  }
});

it("keyLabels of an unbound command is empty, not a crash", () => {
  expect(keyLabels(undefined)).toEqual([]);
  expect(keyLabels("mod+b", false)).toEqual(["Ctrl", "B"]);
});

it("the docs page generator lists bound shortcuts and skips unbound commands", () => {
  const out = fileURLToPath(new URL("../../../docs/site/reference/shortcuts.md", import.meta.url));
  const before = existsSync(out) ? readFileSync(out, "utf8") : undefined;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)), fileURLToPath(new URL("../../../docs/site/scripts/gen-shortcuts.ts", import.meta.url))], { stdio: "pipe" });
    const page = readFileSync(out, "utf8");
    expect(page).toContain("| Toggle sidebar |");
    expect(page).not.toContain("undefined");
    for (const t of ["Open Focus", "Show guide", "MCP servers", "Slash commands", "Manage plugins"]) expect(page).not.toContain(`| ${t} |`);
    // GH-722: the commands without a default key are listed as bullets, so a reader finds them.
    expect(page).toContain("Commands without a default key");
    expect(page).toContain("- Rollback");
    expect(page).toContain("- Switch Claude account");
  } finally {
    if (before !== undefined) writeFileSync(out, before);
    else rmSync(out, { force: true });
  }
}, 30000);

const NEW_IDS = ["git.rollback", "git.branchNew", "git.checkout", "git.checkoutSmart", "git.stash", "git.annotate", "git.merge", "git.rebase", "file.reveal", "changes.addToPrompt", "changes.sendSelection", "account.switch"];

it("GH-722: every 1.3.0 command id is registered once with a title and a group", () => {
  for (const id of NEW_IDS) {
    const found = SHORTCUTS.filter((s) => s.id === id);
    expect(found, id).toHaveLength(1);
    expect(found[0]!.title.length, id).toBeGreaterThan(0);
    expect(["General", "Tabs", "Panels", "Session", "Prefix"]).toContain(found[0]!.group);
  }
});

it("GH-722: 1.3.0 commands have no default key and no KEYS entry", () => {
  for (const id of NEW_IDS) {
    const s = SHORTCUTS.find((x) => x.id === id)!;
    expect(defaultSpec(s, false), id).toBeUndefined();
    expect(defaultSpec(s, true), id).toBeUndefined();
    expect(id in KEYS, id).toBe(false);
  }
});
