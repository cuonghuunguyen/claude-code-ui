// App keyboard shortcuts, OpenCode's default keybinds (`mod` = Cmd on macOS, Ctrl elsewhere) where a browser lets the page have them.

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export type ShortcutGroup = "General" | "Tabs" | "Panels" | "Session" | "Prefix";
export type Shortcut = { id: string; title: string; group: ShortcutGroup; key: string; mac?: string };

const gotoTab = (n: number): Shortcut => ({ id: `tab.goto${n}`, title: `Go to tab ${n}`, group: "Tabs", key: `alt+${n}`, mac: `ctrl+${n}` });

/**
 * Every app shortcut with its default (`mod` = Cmd on macOS, Ctrl elsewhere; `mac`: the macOS default when it differs). Ids are the palette command ids.
 * Each default has Ctrl, Cmd or Alt (shortcuts.test.ts), so it fires in the prompt box and never takes typed text. A user may rebind them (keymap.ts).
 */
export const SHORTCUTS: Shortcut[] = [
  { id: "palette.open", title: "Command palette", group: "General", key: "mod+k" },
  { id: "palette.alt", title: "Command palette (second key)", group: "General", key: "mod+shift+p" },
  { id: "file.open", title: "Open file", group: "General", key: "mod+p" },
  { id: "settings.open", title: "Open settings", group: "General", key: "mod+," },
  { id: "shortcuts.open", title: "Keyboard shortcuts", group: "General", key: "mod+/" },
  { id: "session.new", title: "New session", group: "Tabs", key: "mod+shift+s" },
  // The browser keeps Ctrl+Tab and Ctrl+W (OpenCode's other tab keys) for its own tabs.
  { id: "tab.prev", title: "Previous tab", group: "Tabs", key: "mod+alt+arrowleft" },
  { id: "tab.next", title: "Next tab", group: "Tabs", key: "mod+alt+arrowright" },
  { id: "tab.close", title: "Close tab", group: "Tabs", key: "mod+alt+w" },
  { id: "tab.reopen", title: "Reopen closed tab", group: "Tabs", key: "alt+shift+t", mac: "ctrl+shift+t" },
  // Ctrl/Cmd+1..9 belong to the browser's tabs; Alt+digit is free on Windows and Linux, Ctrl+digit on macOS.
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(gotoTab),
  { id: "tab.gotoLast", title: "Go to last tab", group: "Tabs", key: "alt+9", mac: "ctrl+9" },
  { id: "focus.next", title: "Next waiting request", group: "Session", key: "mod+alt+arrowdown" },
  { id: "sidebar.toggle", title: "Toggle sidebar", group: "Panels", key: "mod+b" },
  { id: "panel.toggle", title: "Toggle side panel", group: "Panels", key: "mod+shift+r" },
  { id: "filetree.toggle", title: "Toggle file tree", group: "Panels", key: "mod+\\" },
  { id: "pane.files", title: "Show files", group: "Panels", key: "mod+shift+e" },
  { id: "pane.changes", title: "Show changes", group: "Panels", key: "mod+shift+g" },
  { id: "pane.graph", title: "Show git graph", group: "Panels", key: "mod+shift+h" },
  { id: "signal.toggle", title: "Toggle signal only", group: "Panels", key: "mod+alt+s" },
  { id: "terminal.toggle", title: "Toggle terminal", group: "Panels", key: "ctrl+`" },
  { id: "terminal.new", title: "New terminal", group: "Panels", key: "ctrl+shift+`" },
  { id: "prompt.focus", title: "Focus prompt", group: "Session", key: "ctrl+l" },
  { id: "model.choose", title: "Change model", group: "Session", key: "mod+'" },
  // tmux's prefix key: the next key picks a command (leader.ts).
  { id: "leader", title: "Prefix key", group: "Prefix", key: "alt+a" },
];

export const shortcutById = (id: string) => SHORTCUTS.find((s) => s.id === id);
export const defaultSpec = (s: Shortcut, mac = IS_MAC) => (mac && s.mac) || s.key;

/** Default specs by id on this platform (labels and tests); the user's own bindings are in keymap.ts. */
export const KEYS = Object.fromEntries(SHORTCUTS.map((s) => [s.id, defaultSpec(s)])) as Record<string, string>;

/** A spec's key and modifiers: the key follows the last "+", and a trailing "+" is the + key ("mod++" is Ctrl and +). */
export const parseSpec = (spec: string) => {
  const i = spec.endsWith("+") ? spec.length - 1 : spec.lastIndexOf("+") + 1;
  return { key: spec.slice(i), mods: new Set(spec.slice(0, i).split("+").filter(Boolean)) };
};

export function matchesKey(spec: string, e: KeyboardEvent, mac = IS_MAC) {
  const { key, mods } = parseSpec(spec);
  const ctrl = mods.has("ctrl") || (mods.has("mod") && !mac);
  const meta = mods.has("meta") || (mods.has("mod") && mac);
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.shiftKey !== mods.has("shift") || e.altKey !== mods.has("alt")) return false;
  // AltGr typing a character (German AltGr+Q is "@", AltGr+7 is "{") is typing, never a shortcut.
  if (altGrChar(e, mac)) return false;
  // Alt+number pad digits are a Windows Alt code in progress (Alt+0169 is "©"): no shortcut, so Alt+1 cannot jump to a tab on the way.
  if (isAltCode(e, mac)) return false;
  // Digits and ` are recorded by their physical key (keymap.ts specFromEvent), and the layout changes e.key on them with any modifier
  // (Czech Alt+1 and macOS Ctrl+1 are "+", AZERTY Ctrl+1 is "&", AZERTY Ctrl+` is "²", Shift+` is "~"): the physical key decides, and only
  // the spec of that key matches, so one press never fires two specs (Czech Alt+1 is alt+1, not alt++).
  if (/^Digit\d$/.test(e.code) || e.code === "Backquote") return CODES[key] === e.code;
  const k = e.key === " " ? "space" : e.key.toLowerCase();
  if (k === key) return true;
  // macOS Option changes e.key (Option+W is "∑"): with Alt a letter matches by its physical key.
  // macOS only: elsewhere Ctrl+Alt is also AltGr, whose typed character (AltGr+W is "|" on a Hungarian layout) must not fire a shortcut.
  return mac && e.altKey && /^[a-z]$/.test(key) && e.code === `Key${key.toUpperCase()}`;
}

const CODES: Record<string, string> = { "`": "Backquote", ...Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [String(n), `Digit${n}`])) };

/** Number pad operators: AltGr does not change them on the layouts tested, so Ctrl+Alt with one is a shortcut. */
const NUMPAD_OPS = new Set(["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide", "NumpadDecimal"]);

/** Off macOS, Alt (alone) with a number pad digit: a Windows Alt code (Alt+0169 types "©"). */
export const isAltCode = (e: KeyboardEvent, mac = IS_MAC) => !mac && e.altKey && !e.ctrlKey && !e.metaKey && /^Numpad\d$/.test(e.code);

/**
 * Off macOS, Ctrl+Alt is AltGr: the character the press types ("@" for German AltGr+Q, "[" for Spanish AltGr+the key right of P, "Dead" for an accent),
 * or undefined when it is a shortcut. A layout's AltGr character cannot be told from its base character, so Ctrl+Alt counts as a shortcut only on
 * an ASCII letter, a digit key that types its digit, a named key (arrows, F2, End), Space or a number pad operator. Any other character
 * counts as AltGr: AZERTY Ctrl+Alt+&, Russian Ctrl+Alt+Л, and US Ctrl+Alt+/ too.
 */
export function altGrChar(e: KeyboardEvent, mac = IS_MAC) {
  if (mac || !e.ctrlKey || !e.altKey) return undefined;
  if (e.key === "Dead") return e.key;
  if ([...e.key].length !== 1 || /^[a-z0-9 ]$/i.test(e.key) || NUMPAD_OPS.has(e.code)) return undefined;
  return e.key;
}

/** Canonical form of a spec for comparing: `mod` resolved for the platform, modifiers in a fixed order. */
export function canon(spec: string, mac = IS_MAC) {
  const { key, mods } = parseSpec(spec);
  const has = (m: string) => mods.has(m) || (mods.has("mod") && m === (mac ? "meta" : "ctrl"));
  return [...["ctrl", "meta", "alt", "shift"].filter(has), key].join("+");
}

const NAMES: Record<string, [mac: string, other: string]> = {
  mod: ["⌘", "Ctrl"],
  ctrl: ["⌃", "Ctrl"],
  meta: ["⌘", "Meta"],
  shift: ["⇧", "Shift"],
  alt: ["⌥", "Alt"],
  arrowleft: ["←", "←"],
  arrowright: ["→", "→"],
  arrowup: ["↑", "↑"],
  arrowdown: ["↓", "↓"],
  escape: ["Esc", "Esc"],
  enter: ["↵", "Enter"],
  tab: ["⇥", "Tab"],
};

/** One label per key, for keybind chips: ["Ctrl", "Shift", "P"] or ["⌘", "⇧", "P"]. */
export const keyLabels = (spec: string, mac = IS_MAC) =>
  spec.split(/\+(?!$)/).map((k) => NAMES[k]?.[mac ? 0 : 1] ?? k.toUpperCase());

/** A spec as one hint string for a button label: "Ctrl+Shift+P", "⌘⇧P" on macOS. */
export const keyText = (spec?: string) => (spec ? keyLabels(spec).join(IS_MAC ? "" : "+") : "");

/** A button label with its key hint, "New terminal (Ctrl+Shift+`)"; the bare label when the binding is removed. */
export const withKey = (label: string, spec?: string) => (spec ? `${label} (${keyText(spec)})` : label);
