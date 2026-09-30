// Slash command picker logic: `/` at the start of an empty-argument prompt lists matching commands and skills.
import type { SlashCommand } from "@claude-ui/protocol";

/** Matching commands while the prompt is `/name-prefix`; undefined when the picker is closed. */
export function matchCommands(commands: SlashCommand[], text: string): SlashCommand[] | undefined {
  const m = /^\/(\S*)$/.exec(text);
  if (!m) return undefined;
  const q = m[1]!.toLowerCase();
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const inner = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...prefix, ...inner];
}

/** Choosing a command sends it, unless it takes arguments: then the prompt box gets `/name ` to type them. */
export function choose(c: SlashCommand): { send: string } | { text: string } {
  return c.argumentHint ? { text: `/${c.name} ` } : { send: `/${c.name}` };
}
