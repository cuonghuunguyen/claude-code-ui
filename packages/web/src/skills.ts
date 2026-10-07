// "Slash commands" dialog logic, same behaviour as the Claude Code VS Code extension, own texts.
import type { SkillRow, SkillState, SlashCommand } from "@claude-ui/protocol";

export const STATES: SkillState[] = ["on", "name-only", "user-invocable-only", "off"];
export const STATE_LABEL: Record<SkillState, string> = { on: "On", "name-only": "Name only", "user-invocable-only": "User only", off: "Off" };
export const STATE_HINT: Record<SkillState, string> = {
  on: "Claude sees it and you can invoke it",
  "name-only": "Claude sees only its name",
  "user-invocable-only": "Only you can invoke it; hidden from Claude",
  off: "Not shown to Claude or in the command list",
};
/** An unknown state (newer CLI) shows as sent and cycles to On. */
export const stateLabel = (s: string) => STATE_LABEL[s as SkillState] ?? s;
export const stateHint = (s: string) => STATE_HINT[s as SkillState] ?? s;
export const nextState = (s: string): SkillState => STATES[(STATES.indexOf(s as SkillState) + 1) % STATES.length]!;

const HIGHER = "Overridden by a higher-priority setting";
const LOCKS: Record<string, string> = {
  plugin: "Controlled by its plugin",
  author: "Fixed in the skill file",
  policy: HIGHER,
  flag: HIGHER,
  "reserved-name": "This name can't be saved in settings; rename the skill's folder or file to change it",
};
export const lockText = (lockedBy: string) => LOCKS[lockedBy] ?? HIGHER;

export const NOTICE_SLOW = "No confirmation from Claude Code in time; this session still has the old state. Retry, or reopen the dialog to check.";
export const NOTICE_UNCONFIRMED = "Saved. This session still has the old state and may not have reloaded yet; reopen the dialog to check.";

export const tokenText = (n: number) => (n < 20 ? "< 20" : `~${n}`);
export const skillMeta = (s: SkillRow) => `${s.source} · ${tokenText(s.tokens)} tokens`;

/** `command`: the picker's command; `skill`: its get_skills_dialog row. Inert rows have no command. */
export type Row = { id: string; label: string; description: string; command?: SlashCommand; skill?: SkillRow };

/** The skill a command is: a qualified alias of the command, else the same name, else a bare name the skill answers to (its `handles.aliases`) or an unqualified display name. */
function skillOf(c: SlashCommand, advertised: SkillRow[]) {
  const qualified = c.aliases?.filter((a) => a.includes(":"));
  return advertised.find((s) => qualified?.includes(s.name)) ?? advertised.find((s) => s.name === c.name) ?? advertised.find((s) => s.handles?.aliases?.includes(c.name) || (!s.name.includes(":") && s.displayName === c.name));
}

/**
 * Every command, then the skills that are no command (state Off or User only, not advertised, or no command list: the
 * new-session tab) as inert rows. Commands without a skill come first, then skills by source and name. `filter` matches the
 * name, description and source, case-insensitive, ignoring a leading `/`.
 */
export function buildRows(commands: SlashCommand[], skills: SkillRow[], filter = ""): Row[] {
  const advertised = skills.filter((s) => s.advertised);
  const used = new Set<SkillRow>();
  const bySource = (a: SkillRow | undefined, b: SkillRow | undefined, an: string, bn: string) =>
    (a ? 1 : 0) - (b ? 1 : 0) || (a?.source ?? "").localeCompare(b?.source ?? "") || an.localeCompare(bn);
  const joined = commands.map((command) => {
    const skill = skillOf(command, advertised);
    if (skill) used.add(skill);
    return { id: `command:${command.name}`, label: `/${command.name}`, description: command.description, command, skill } satisfies Row;
  });
  joined.sort((a, b) => bySource(a.skill, b.skill, a.command.name, b.command.name));
  const inert = skills.filter((s) => !used.has(s));
  // Two hidden skills with one display name (different plugins) show their full names.
  const label = (s: SkillRow) => `/${inert.some((o) => o !== s && o.displayName === s.displayName) ? s.name : s.displayName}`;
  const extra = inert
    .sort((a, b) => bySource(a, b, a.name, b.name))
    .map((skill) => ({ id: `skill:${skill.name}`, label: label(skill), description: skill.description, skill }) satisfies Row);
  const q = filter.trim().replace(/^\//, "").toLowerCase();
  const rows: Row[] = [...joined, ...extra];
  return q ? rows.filter((r) => [r.label.slice(1), r.description, r.skill?.source, ...(r.command?.aliases ?? [])].some((t) => t?.toLowerCase().includes(q))) : rows;
}
