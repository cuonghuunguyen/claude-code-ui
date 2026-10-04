// Slash command picker logic: `/` at the start of an empty-argument prompt lists matching commands and skills.
import type { SlashCommand } from "@claude-ui/protocol";

/** Matching commands while the prompt is `/name-prefix`; undefined when the picker is closed. */
export function matchCommands(commands: SlashCommand[], text: string): SlashCommand[] | undefined {
  const m = /^\/(\S*)$/.exec(text);
  if (!m) return undefined;
  const q = m[1]!.toLowerCase();
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

/** Commands the web app handles itself, like the VS Code extension: typed alone they open a dialog and are not sent. */
export const DIALOG_COMMANDS: (SlashCommand & { dialog: "mcp" })[] = [{ name: "mcp", description: "Configure Model Context Protocol servers", argumentHint: "", dialog: "mcp" }];

/** The picker's rows: the session's commands plus the dialog commands (a CLI row of the same name gives way). */
export const withDialogCommands = (commands: SlashCommand[]): SlashCommand[] => [...commands.filter((c) => !DIALOG_COMMANDS.some((d) => d.name === c.name)), ...DIALOG_COMMANDS];

/** The dialog a prompt opens instead of being sent: `/mcp` alone (always intercepted, as in the extension). */
export const dialogOf = (text: string) => DIALOG_COMMANDS.find((d) => text.trim() === `/${d.name}`)?.dialog;
