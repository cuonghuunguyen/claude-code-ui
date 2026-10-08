// The user's keybindings (docs/spec.md "Keyboard shortcuts"): overrides of the defaults in shortcuts.ts, kept per browser.
import { useSyncExternalStore } from "react";
import { IS_MAC, SHORTCUTS, canon, matchesKey, defaultSpec, shortcutById, type Shortcut } from "./shortcuts.ts";
import { FORMAT_KEYS } from "./markdown-toolbar.tsx";

const KEY = "claude-ui.keybindings";

/** Combos the browser keeps for itself: a page never receives them (Chrome, Edge, Firefox). */
const RESERVED = ["mod+t", "mod+w", "mod+n", "mod+shift+t", "mod+shift+n", "mod+shift+w", "ctrl+tab", "ctrl+shift+tab", "ctrl+pageup", "ctrl+pagedown", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `mod+${n}`)];

/** Why `spec` cannot be a binding, or undefined when it can. */
export function bindingError(spec: string, mac = IS_MAC) {
  const mods = spec.split("+").slice(0, -1);
  if (!mods.some((m) => m === "mod" || m === "ctrl" || m === "meta" || m === "alt")) return "Use Ctrl, Cmd or Alt with the key, or it would fire while typing";
  if (RESERVED.some((r) => canon(r, mac) === canon(spec, mac))) return "The browser keeps this shortcut";
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

/** What `spec` would clash with as the binding of `id`: another shortcut, or a prompt box format key. Mod+B is the sidebar's by default and bold in the prompt box on purpose. */
export function conflictOf(id: string, spec: string, mac = IS_MAC): { id?: string; title: string } | undefined {
  const c = canon(spec, mac);
  const other = SHORTCUTS.find((s: Shortcut) => s.id !== id && specOf(s.id, mac) && canon(specOf(s.id, mac)!, mac) === c);
  if (other) return { id: other.id, title: other.title };
  if (id !== "sidebar.toggle") {
    const f = Object.entries(FORMAT_KEYS).find(([, k]) => canon(k, mac) === c);
    if (f) return { title: `${f[0][0]!.toUpperCase()}${f[0].slice(1)} in the prompt box` };
  }
  return undefined;
}

/** The spec of a key press for the recorder; undefined for a modifier alone. */
export function specFromEvent(e: KeyboardEvent, mac = IS_MAC) {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(e.key)) return undefined;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.code === "Backquote" ? "`" : e.key === " " ? "space" : e.key.toLowerCase();
  const mods = [e.ctrlKey && !mac && "mod", e.metaKey && mac && "mod", e.ctrlKey && mac && "ctrl", e.metaKey && !mac && "meta", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean);
  return [...mods, key].join("+");
}

const TERMINAL_KEYS = ["terminal.toggle", "terminal.new", "palette.open", "palette.alt", "shortcuts.open"];

/** App keys that leave the terminal (xterm) for the app: the prefix key, tab keys, palette, shortcuts and terminal keys, and anything with Alt. Plain Ctrl+letter stays with the shell. */
export const leavesTerminal = (e: KeyboardEvent) =>
  SHORTCUTS.some((s) => {
    const spec = specOf(s.id);
    return !!spec && matchesKey(spec, e) && (spec.split("+").slice(0, -1).includes("alt") || TERMINAL_KEYS.includes(s.id) || s.id.startsWith("tab.goto"));
  });
