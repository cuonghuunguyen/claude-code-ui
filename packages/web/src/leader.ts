// The prefix key (tmux): pressing it arms for a moment; the next plain key picks a command.

export const LEADER_MS = 1500;

/** Second keys: key -> command id (app-commands.ts) or "palette". Digits are tab numbers, 9 is the last tab. */
export const PREFIX_KEYS: { key: string; id: string; title: string }[] = [
  { key: "c", id: "session.new", title: "New session" },
  { key: "n", id: "tab.next", title: "Next tab" },
  { key: "p", id: "tab.prev", title: "Previous tab" },
  { key: "1-9", id: "tab.goto1", title: "Tab 1 to 9" },
  { key: "x", id: "tab.close", title: "Close tab" },
  { key: "t", id: "terminal.toggle", title: "Terminal" },
  { key: "f", id: "pane.files", title: "Files" },
  { key: "g", id: "pane.changes", title: "Changes" },
  { key: "s", id: "sidebar.toggle", title: "Sidebar" },
  { key: "z", id: "prompt.focus", title: "Focus prompt" },
  { key: ",", id: "settings.open", title: "Settings" },
  { key: "?", id: "shortcuts.open", title: "Shortcuts" },
  { key: ":", id: "palette.open", title: "Command palette" },
];

/** The command id a second key runs; undefined for an unknown key. */
export function prefixCommand(key: string) {
  if (/^[1-8]$/.test(key)) return `tab.goto${key}`;
  if (key === "9") return "tab.gotoLast";
  return PREFIX_KEYS.find((p) => p.key === key.toLowerCase())?.id;
}

type Press = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean };
const MODIFIERS = ["Shift", "Control", "Alt", "Meta", "AltGraph"];

/** One key press. `armedAt`: when the prefix key was pressed (undefined: not armed). `swallow`: the press must not reach the page. `run`: the command id of a valid second key. */
export function leaderStep(armedAt: number | undefined, e: Press, now: number, isLeader: boolean): { armedAt?: number; swallow: boolean; run?: string } {
  if (armedAt === undefined || now - armedAt > LEADER_MS) return isLeader ? { armedAt: now, swallow: true } : { swallow: false };
  // Shift alone (before "?" or ":") keeps the prefix armed.
  if (MODIFIERS.includes(e.key)) return { armedAt, swallow: false };
  const run = e.ctrlKey || e.metaKey || e.altKey ? undefined : prefixCommand(e.key);
  return { swallow: true, run };
}
