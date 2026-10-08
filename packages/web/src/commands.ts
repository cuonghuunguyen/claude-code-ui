// Slash command picker logic: `/` at the start of an empty-argument prompt lists matching commands and skills.
import type { SlashCommand } from "@claude-ui/protocol";

export type CommandToken = { start: number; query: string; /** End of the whole word: a caret inside it leaves the rest of the word after the caret. */ end: number; lead: boolean };

/**
 * The `/word` that ends at the caret and starts the text or follows whitespace (like `@`); undefined when the picker is closed.
 * `lead`: the word is the whole prompt, so a picked row runs as a command; otherwise a picked row only replaces the token.
 */
export function activeCommand(text: string, caret: number): CommandToken | undefined {
  const m = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret));
  if (!m) return undefined;
  const start = caret - m[1]!.length - 1;
  const end = caret + /^\S*/.exec(text.slice(caret))![0].length;
  return { start, query: m[1]!, end, lead: start === 0 && !text.slice(end).trim() };
}

/** The text after choosing a command in the middle of a prompt: the token becomes `/name ` (one space) and the caret goes after it. */
export function insertSlash(text: string, t: CommandToken, name: string) {
  const token = `/${name} `;
  return { text: text.slice(0, t.start) + token + text.slice(t.end).replace(/^ /, ""), caret: t.start + token.length };
}

/** Matching commands for the `/name-prefix` at the caret; undefined when the picker is closed. */
export function matchCommands(commands: SlashCommand[], text: string, caret = text.length): SlashCommand[] | undefined {
  const m = activeCommand(text, caret);
  if (!m) return undefined;
  const q = m.query.toLowerCase();
  const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase());
  // 0 exact, 1 prefix, 2 substring, 3 no match; Enter picks the first row, so an exact name wins.
  const rank = (c: SlashCommand) =>
    names(c).includes(q) ? 0 : names(c).some((n) => n.startsWith(q)) ? 1 : c.name.toLowerCase().includes(q) ? 2 : 3;
  return commands
    .map((c) => ({ c, r: rank(c) }))
    .filter((x) => x.r < 3)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.c);
}

/**
 * Choosing a command sends it, unless it takes arguments and was not typed in full: then the prompt box gets `/name ` to type them.
 * `typed`: the prompt box text; `/name` typed in full sends at once, as Enter does in Claude Code.
 */
export function choose(c: SlashCommand, typed = ""): { send: string } | { text: string } {
  const full = [c.name, ...(c.aliases ?? [])].some((n) => typed.toLowerCase() === `/${n.toLowerCase()}`);
  return c.argumentHint && !full ? { text: `/${c.name} ` } : { send: `/${c.name}` };
}

/** The dialogs the web app opens itself. */
export type DialogName = "mcp" | "skills" | "plugins" | "resume";

/**
 * Commands the web app handles itself, like the VS Code extension: typed alone they open a dialog and are not sent.
 * `always`: also when the CLI has a command of that name (`/mcp`); the others only without one (the CLI's own command wins).
 */
export const DIALOG_COMMANDS: (SlashCommand & { dialog: DialogName; always?: boolean })[] = [
  { name: "mcp", description: "Configure Model Context Protocol servers", argumentHint: "", dialog: "mcp", always: true },
  { name: "skills", description: "List available skills", argumentHint: "", dialog: "skills" },
  { name: "plugins", aliases: ["plugin", "marketplace"], description: "Install, enable, or disable plugins", argumentHint: "", dialog: "plugins" },
  { name: "resume", description: "Resume a previous session", argumentHint: "", dialog: "resume", always: true },
];

const has = (commands: SlashCommand[], name: string) => commands.some((c) => c.name === name || c.aliases?.includes(name));

/** The picker's rows: the session's commands plus the dialog commands (a CLI row of the same name gives way to `always` ones). */
export const withDialogCommands = (commands: SlashCommand[]): SlashCommand[] => [
  ...commands.filter((c) => !DIALOG_COMMANDS.some((d) => d.always && d.name === c.name)),
  ...DIALOG_COMMANDS.filter((d) => d.always || !has(commands, d.name)),
];

/** The dialog a prompt opens instead of being sent: `/mcp` alone; `/resume` alone or with text; `/skills`, `/help`, `/plugins`, `/plugin`, `/marketplace` alone unless the CLI has a command of that name. */
export function dialogOf(text: string, commands: SlashCommand[] = []): DialogName | undefined {
  const m = /^\/(\S+)(\s+\S[\s\S]*)?$/.exec(text.trim());
  const name = m?.[1];
  if (!name) return undefined;
  const d = DIALOG_COMMANDS.find((d) => d.name === name || d.aliases?.includes(name) || (name === "help" && d.dialog === "skills"));
  if (!d || (m[2] && d.dialog !== "resume")) return undefined;
  return d.always || !has(commands, name) ? d.dialog : undefined;
}

/** The text after `/resume`, which goes into the session search; undefined without any. */
export const dialogArg = (text: string) => /^\/resume\s+(\S[\s\S]*)$/.exec(text.trim())?.[1];
