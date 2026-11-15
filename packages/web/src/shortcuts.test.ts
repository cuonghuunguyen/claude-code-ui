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

it("unbound registry commands have no default and no KEYS entry", () => {
  for (const id of [
  "focus.open", "guide.start", "mcp.open", "skills.open", "plugins.open",
  "git.rollback", "git.branchNew", "git.checkout", "git.checkoutSmart", "git.stash", "git.annotate", "git.merge", "git.rebase", "file.reveal", "changes.addToPrompt", "changes.sendSelection", "account.switch",
  ]) {
    const s = SHORTCUTS.find((x) => x.id === id)!;
    expect(defaultSpec(s, false), id).toBeUndefined();
    expect(defaultSpec(s, true), id).toBeUndefined();
    expect(id in KEYS, id).toBe(false);
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
