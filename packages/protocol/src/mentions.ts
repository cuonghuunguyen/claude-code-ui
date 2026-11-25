/** One `@<subagent>` mention found in a prompt: JS string indices into the text, `end` exclusive, `value` = `@<name>`. */
export type AgentMention = { name: string; start: number; end: number; value: string };

const NAME_CHAR = /[\w.-]/;
const AFTER = /[\s.,;:!?)\]]/;

/** The ranges of pasted-content blocks (the CLI's wrapper around a pasted text): a mention inside is not one. */
const pastedRanges = (text: string): [number, number][] => {
  const out: [number, number][] = [];
  const open = /<pasted_content id="([0-9a-f]{4})">\n/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const close = text.indexOf(`\n</pasted_content id="${m[1]}">`, open.lastIndex);
    const end = close < 0 ? text.length : close;
    out.push([m.index, end]);
    open.lastIndex = Math.max(open.lastIndex, end);
  }
  return out;
};

/**
 * The `@<name>` tokens of OpenCode subagents in a prompt, the first of each name, in order of appearance. A token starts the text or follows
 * whitespace, and ends the text, whitespace or one of `.,;:!?)]`. `@name/` (a folder), `@name.ext` (a file), `@names` and `a@name` are no mention.
 * One rule for the daemon (the part sent to OpenCode) and the web (the bubble).
 */
export function agentMentions(text: string, names: readonly string[]): AgentMention[] {
  if (!names.length || !text.includes("@")) return [];
  const known = new Set(names);
  const skip = pastedRanges(text);
  const out: AgentMention[] = [];
  const seen = new Set<string>();
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    if (at > 0 && !/\s/.test(text[at - 1]!)) continue;
    if (skip.some(([a, b]) => at >= a && at < b)) continue;
    let end = at + 1;
    while (end < text.length && NAME_CHAR.test(text[end]!)) end++;
    // A name ends at a dot only when the dot closes the sentence: `@explore.` yes, `@explore.md` no.
    let name = text.slice(at + 1, end);
    while (name && !known.has(name)) {
      const dot = Math.max(name.lastIndexOf("."), name.lastIndexOf("-"));
      if (dot < 1) break;
      name = name.slice(0, dot);
    }
    if (!known.has(name)) continue;
    end = at + 1 + name.length;
    const next = text[end];
    if (next !== undefined && !AFTER.test(next)) continue;
    // `@name.` at a word: a dot followed by a name character is a file extension (`@explore.md`).
    if (next === "." && end + 1 < text.length && NAME_CHAR.test(text[end + 1]!)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, start: at, end, value: `@${name}` });
  }
  return out;
}
