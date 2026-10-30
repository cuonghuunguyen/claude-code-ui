// The user's keybindings (docs/spec.md "Keyboard shortcuts"): overrides of the defaults in shortcuts.ts, kept per browser.
import { useSyncExternalStore } from "react";
import { IS_MAC, SHORTCUTS, altGrChar, canon, isAltCode, matchesKey, parseSpec, defaultSpec, shortcutById, type Shortcut } from "./shortcuts.ts";
import { FORMAT_KEYS } from "./markdown-toolbar.tsx";
import { t, type Key } from "./i18n.ts";
import { shortcutTitle } from "./shortcut-titles.ts";

const KEY = "claude-ui.keybindings";

/** Combos the browser keeps for itself: a page never receives them (Chrome, Edge, Firefox). */
const RESERVED = ["mod+t", "mod+w", "mod+n", "mod+shift+t", "mod+shift+n", "mod+shift+w", "ctrl+tab", "ctrl+shift+tab", "ctrl+pageup", "ctrl+pagedown", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `mod+${n}`)];

/** Keys the prompt box uses for editing (spec -> what it does): binding one would block paste, undo or word navigation there. `mod` is Ctrl, Cmd on macOS. */
// The second item is a catalog key: the text is looked up when the message is built, never at module load.
const EDITING_ALL: [string, Key][] = [
  ["mod+a", "keymap.edit.selectAll"], ["mod+c", "keymap.edit.copy"], ["mod+v", "keymap.edit.paste"], ["mod+shift+v", "keymap.edit.pastePlain"], ["mod+x", "keymap.edit.cut"], ["mod+z", "keymap.edit.undo"], ["mod+shift+z", "keymap.edit.redo"],
];
const arrows = (mod: string, what: Key, keys = ["arrowleft", "arrowright", "arrowup", "arrowdown"]): [string, Key][] =>
  keys.flatMap((k) => [[`${mod}+${k}`, what] as [string, Key], [`${mod}+shift+${k}`, what]]);
const EDITING_WIN: [string, Key][] = [
  ["mod+y", "keymap.edit.redo"], ["mod+backspace", "keymap.edit.deleteWord"], ["mod+delete", "keymap.edit.deleteWord"],
  ...arrows("mod", "keymap.edit.moveWord", ["arrowleft", "arrowright"]), ...arrows("mod", "keymap.edit.moveParagraph", ["arrowup", "arrowdown"]),
  ...arrows("mod", "keymap.edit.startEndText", ["home", "end"]),
];
const EDITING_MAC: [string, Key][] = [
  ["mod+backspace", "keymap.edit.deleteLine"], ["alt+backspace", "keymap.edit.deleteWord"], ["alt+delete", "keymap.edit.deleteWord"],
  ...arrows("mod", "keymap.edit.startEndLineText"), ...arrows("alt", "keymap.edit.moveWord"),
];

/** What the prompt box does with this key, or undefined. */
const editingKey = (spec: string, mac: boolean) => {
  const c = canon(spec, mac);
  const hit = [...EDITING_ALL, ...(mac ? EDITING_MAC : EDITING_WIN)].find(([s]) => canon(s, mac) === c);
  return hit && t(hit[1]);
};

/** Why `spec` cannot be a binding, or undefined when it can. */
export function bindingError(spec: string, mac = IS_MAC) {
  const { key, mods: set } = parseSpec(spec);
  const mods = [...set];
  // Older builds stored "dead": it fires on every dead key.
  if (["dead", "unidentified", "process", ""].includes(key)) return t("keymap.cannot");
  if (!mods.some((m) => m === "mod" || m === "ctrl" || m === "meta" || m === "alt")) return t("keymap.needsMod");
  const ctrl = set.has("ctrl") || (set.has("mod") && !mac);
  const meta = set.has("meta") || (set.has("mod") && mac);
  const typable = [...key].length === 1 || key === "space";
  // AltGr types a character with a punctuation or non-ASCII key (Spanish AltGr+[ key types "["). A spec cannot tell the number pad from the
  // main row, so the number pad operators stay allowed (the recorder refuses them on the main row).
  if (!mac && ctrl && set.has("alt") && !meta && [...key].length === 1 && !/^[a-z0-9+\-*/.]$/.test(key)) return t("keymap.altGrType");
  // Option (+Shift) on a printing key types a character on macOS (Option+L is "@" on a German layout).
  if (mac && set.has("alt") && !ctrl && !meta && typable) return t("keymap.optionType");
  if (RESERVED.some((r) => canon(r, mac) === canon(spec, mac))) return t("keymap.reserved");
  const editing = editingKey(spec, mac);
  if (editing) return t("keymap.promptUses", { what: editing });
  return undefined;
}

type Overrides = Record<string, string | null>;

/** Stored overrides without unknown ids and invalid specs. */
export function parseOverrides(raw: string | null | undefined): Overrides {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([id, s]) => shortcutById(id) && (s === null || (typeof s === "string" && !bindingError(s)))) as [string, string | null][]);
  } catch {
    return {};
  }
}

const read = () => {
  try {
    return parseOverrides(localStorage.getItem(KEY));
  } catch {
    return {};
  }
};
let overrides = read();
const subs = new Set<() => void>();
const set = (next: Overrides) => {
  overrides = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the bindings last for this page.
  }
  subs.forEach((f) => f());
};

/** The spec `id` is bound to now; undefined when the user removed the binding. */
export const specOf = (id: string, mac = IS_MAC) => {
  if (id in overrides) return overrides[id] ?? undefined;
  const s = shortcutById(id);
  return s && defaultSpec(s, mac);
};
export const isChanged = (id: string) => id in overrides;
export const bind = (id: string, spec: string | null) => set({ ...overrides, [id]: spec });
export const resetBinding = (id: string) => set(Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== id)));
export const resetAll = () => set({});

/** Re-renders on a binding change; returns `specOf`. */
export function useKeymap() {
  useSyncExternalStore(
    (cb) => (subs.add(cb), () => void subs.delete(cb)),
    () => overrides,
  );
  return specOf;
}

/**
 * What `spec` would clash with as the binding of `id`: another shortcut, or a prompt box format key. Mod+B is the sidebar's by default and bold in the prompt box on purpose.
 * With the recorded press `e`, a binding that fires on the same press counts too, whatever its spec string says.
 */
export function conflictOf(id: string, spec: string, mac = IS_MAC, e?: KeyboardEvent): { id?: string; title: string } | undefined {
  const c = canon(spec, mac);
  const bound = (s: Shortcut) => (s.id !== id ? specOf(s.id, mac) : undefined);
  const other = SHORTCUTS.find((s) => bound(s) && (canon(bound(s)!, mac) === c || (e && matchesKey(bound(s)!, e, mac))));
  if (other) return { id: other.id, title: shortcutTitle(other.id) };
  if (id !== "sidebar.toggle") {
    const f = Object.entries(FORMAT_KEYS).find(([, k]) => canon(k, mac) === c || (e && matchesKey(k, e, mac)));
    if (f) {
      const name = t(`shortcuts.format.${f[0] as keyof typeof FORMAT_KEYS}`);
      return { title: t("shortcuts.inPromptBox", { name: `${name[0]!.toUpperCase()}${name.slice(1)}` }) };
    }
  }
  return undefined;
}

/** The spec of a key press for the recorder (check pressError first); undefined for a modifier alone. A letter is the typed one (`e.key`), as matchesKey compares it, so a rebind works on QWERTZ, AZERTY and Dvorak; only macOS Option, which changes `e.key`, records the physical key. */
export function specFromEvent(e: KeyboardEvent, mac = IS_MAC) {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return undefined;
  const key = physicalKey(e, mac) ?? (e.key === " " ? "space" : e.key.toLowerCase());
  const mods = [e.ctrlKey && !mac && "mod", e.metaKey && mac && "mod", e.ctrlKey && mac && "ctrl", e.metaKey && !mac && "meta", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean);
  return [...mods, key].join("+");
}

/** The key a press is recorded by when the physical key decides (digits, `, macOS Option+letter; matchesKey compares them by `code` too), else undefined. */
const physicalKey = (e: KeyboardEvent, mac: boolean) =>
  mac && e.altKey && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code === "Backquote" ? "`" : undefined;

/** Why the recorder refuses this key press, or undefined when it can be a binding (then specFromEvent and bindingError decide). */
export function pressError(e: KeyboardEvent, mac = IS_MAC) {
  const altGr = altGrChar(e, mac);
  if (altGr === "Dead") return t("keymap.altGrDead");
  if (altGr) return t("keymap.altGrChar", { char: altGr });
  if (isAltCode(e, mac)) return t("keymap.altCode");
  if (mac && e.altKey && !e.ctrlKey && !e.metaKey && typesCharacter(e)) {
    if (e.key === "Dead") return t("keymap.optionDead");
    return t("keymap.optionChar", { char: e.key === " " ? t("keymap.noBreakSpace") : `“${e.key}”` });
  }
  if (physicalKey(e, mac)) return undefined;
  // Every dead key reports "Dead": a binding on one would fire on all of them.
  if (e.key === "Dead") return t("keymap.dead");
  if (e.key === "Unidentified" || e.key === "Process") return t("keymap.unidentified");
  return undefined;
}

/** A printing key: one character (or a dead key), or a letter, digit, punctuation or Space key. Arrows, F-keys, Enter and the like are named keys. */
const typesCharacter = (e: KeyboardEvent) =>
  [...e.key].length === 1 || e.key === "Dead" || /^(Key[A-Z]|Digit\d|Backquote|Space|IntlBackslash|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash)$/.test(e.code);

const TERMINAL_KEYS = ["terminal.toggle", "terminal.new", "palette.open", "palette.alt", "shortcuts.open"];

/** App keys that leave the terminal (xterm) for the app: the prefix key, tab keys, palette, shortcuts and terminal keys, and anything with Alt. Plain Ctrl+letter stays with the shell. */
export const leavesTerminal = (e: KeyboardEvent) =>
  SHORTCUTS.some((s) => {
    const spec = specOf(s.id);
    return !!spec && matchesKey(spec, e) && (parseSpec(spec).mods.has("alt") || TERMINAL_KEYS.includes(s.id) || s.id.startsWith("tab.goto"));
  });
