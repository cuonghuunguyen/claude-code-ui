// App keyboard shortcuts, OpenCode's default keybinds (`mod` = Cmd on macOS, Ctrl elsewhere) where a browser lets the page have them.

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Every app shortcut has Ctrl, Cmd or Alt (shortcuts.test.ts), so it fires in the prompt box and never takes typed text. */
export const KEYS = {
  palette: "mod+k",
  paletteAlt: "mod+shift+p",
  newSession: "mod+shift+s",
  // The browser keeps Ctrl+Tab and Ctrl+W (OpenCode's other tab keys) for its own tabs.
  prevTab: "mod+alt+arrowleft",
  nextTab: "mod+alt+arrowright",
  closeTab: "mod+alt+w",
  quickOpen: "mod+p",
  sidebar: "mod+b",
  sidePanel: "mod+shift+r",
  focusPrompt: "ctrl+l",
  model: "mod+'",
} as const;

const parse = (spec: string) => {
  const parts = spec.split("+");
  // "mod+'" and a literal "+" key: the key is the last part, the rest are modifiers.
  return { key: parts.at(-1)!, mods: new Set(parts.slice(0, -1)) };
};

export function matchesKey(spec: string, e: KeyboardEvent, mac = IS_MAC) {
  const { key, mods } = parse(spec);
  const ctrl = mods.has("ctrl") || (mods.has("mod") && !mac);
  const meta = mods.has("meta") || (mods.has("mod") && mac);
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.shiftKey !== mods.has("shift") || e.altKey !== mods.has("alt")) return false;
  // macOS Option changes e.key (Option+W is "∑"): with Alt a letter matches by its physical key.
  return e.key.toLowerCase() === key || (e.altKey && /^[a-z]$/.test(key) && e.code === `Key${key.toUpperCase()}`);
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
