// "Slash commands" dialog (/skills), behaves like the Claude Code VS Code extension's: every command, and for skills their source,
// token cost and state button. Logic and texts in skills.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import type { SkillRow, SkillsResult, SkillsSetStateResult, SlashCommand } from "@claude-ui/protocol";
import type { Request, RequestError } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { choose } from "./commands.ts";
import { buildRows, lockText, nextState, NOTICE_SLOW, NOTICE_UNCONFIRMED, skillMeta, stateHint, stateLabel, type Row } from "./skills.ts";

/**
 * `commands`: the shown session's commands (none on the new-session tab: every skill is then an inert row). `onRun`: what
 * clicking a command does, as `choose()` decides (send it, or put `/name ` in the prompt box). `changed`: bumped on `config.changed` for `cwd`.
 */
export function SkillsDialog({
  open,
  cwd,
  sessionId,
  commands,
  changed = 0,
  request,
  onRun,
  onClose,
}: {
  open: boolean;
  cwd: string;
  sessionId?: string;
  commands: SlashCommand[];
  changed?: number;
  request: <T>(msg: Request) => Promise<T>;
  onRun: (r: ReturnType<typeof choose>) => void;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [saving, setSaving] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState("");

  const base = { cwd, ...(sessionId && { sessionId }) };
  const ask = useRef(request);
  ask.current = request;
  const where = useRef(base);
  where.current = base;
  // A slower older answer must not replace a newer one.
  const sent = useRef(0);
  const shown = useRef(0);
  const load = useCallback(async () => {
    const n = ++sent.current;
    try {
      const r = await ask.current<SkillsResult>({ type: "skills.list", ...where.current });
      if (n < shown.current) return;
      shown.current = n;
      setLoadError(undefined);
      setSkills(r.skills);
    } catch (e) {
      if (n < shown.current) return;
      shown.current = n;
      setLoadError((e as Error).message || "Failed to load skills");
    } finally {
      if (n === shown.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setSkills([]);
    setLoading(true);
    setSaving(undefined);
    setError(undefined);
    setNotice(undefined);
    setFilter("");
    void load();
  }, [open, cwd, sessionId]);
  useEffect(() => void (open && changed && load()), [changed]);

  /** Cycles a skill's state: the row shows the next one at once, then the daemon's answer (the session's own view of it). */
  async function change(skill: SkillRow) {
    if (saving) return;
    const state = nextState(skill.state);
    setError(undefined);
    setNotice(undefined);
    setSaving(skill.name);
    setSkills((all) => all.map((s) => (s.name === skill.name ? { ...s, state } : s)));
    try {
      const r = await request<SkillsSetStateResult>({ type: "skills.setState", ...base, name: skill.name, state, ...(skill.handles && { handles: skill.handles }) });
      setSkills(r.skills);
      if (!r.confirmed) setNotice(NOTICE_UNCONFIRMED);
    } catch (e) {
      if ((e as RequestError).code === "cli_timeout") setNotice(NOTICE_SLOW);
      else setError((e as Error).message || "Failed to change the skill state");
      // Back to what the session shows.
      await load();
    } finally {
      setSaving(undefined);
    }
  }

  const rows = buildRows(commands, skills, filter);
  const none = !commands.length && !skills.length;

  return (
    <ConfigDialog title="Slash commands" open={open} onClose={onClose} testId="skills-dialog">
      <label className="relative flex items-center">
        <SearchIcon className="pointer-events-none absolute left-3 size-4 text-faint" aria-hidden />
        <input
          autoFocus
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter commands…"
          aria-label="Filter commands…"
          autoComplete="off"
          spellCheck={false}
          className="h-9 w-full rounded-md bg-secondary/60 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary max-md:h-11 max-md:text-base"
          data-testid="skills-filter"
        />
      </label>
      {loadError && <Banner kind="error">Failed to load skills: {loadError}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}
      {loading && !!commands.length && <p className="text-muted-foreground text-sm">Loading skills…</p>}
      {loading && !commands.length && <p className="text-muted-foreground text-sm">Loading commands…</p>}
      {!loading && !rows.length && <p className="py-6 text-center text-muted-foreground text-sm">{none || !filter.trim() ? "No slash commands available." : "No matching commands."}</p>}
      <div className="flex flex-col gap-px" data-testid="skills-list">
        {rows.map((r) => (
          <SkillRowView key={r.id} row={r} saving={saving} onRun={(c) => (onRun(choose(c)), onClose())} onChange={change} />
        ))}
      </div>
    </ConfigDialog>
  );
}

function SkillRowView({ row, saving, onRun, onChange }: { row: Row; saving?: string; onRun: (c: SlashCommand) => void; onChange: (s: SkillRow) => void }) {
  const { skill, command } = row;
  // The extension shows a skill's source and cost in the description's place; the description is the tooltip.
  const body = (
    <>
      <span className="block truncate font-medium text-[13px]">{row.label}</span>
      <span className="block truncate text-[13px] text-muted-foreground">{skill ? skillMeta(skill) : row.description}</span>
    </>
  );
  const cls = "min-h-11 min-w-0 flex-1 rounded-md px-3 py-1 text-left md:min-h-10";
  return (
    <div className="flex items-center gap-2 rounded-md hover:bg-secondary" data-testid="skills-row">
      {command ? (
        <button type="button" className={`${cls} outline-none focus-visible:ring-2 focus-visible:ring-ring`} title={row.description} onClick={() => onRun(command)}>
          {body}
        </button>
      ) : (
        <div className={`${cls} flex flex-col justify-center`} title={row.description} data-testid="skills-inert">
          {body}
        </div>
      )}
      {skill && <StateControl skill={skill} label={row.label} saving={saving} onChange={onChange} />}
    </div>
  );
}

function StateControl({ skill, label, saving, onChange }: { skill: SkillRow; label: string; saving?: string; onChange: (s: SkillRow) => void }) {
  const text = stateLabel(skill.state);
  if (skill.lockedBy)
    return (
      <span className="mr-3 shrink-0 text-[13px] text-muted-foreground" title={lockText(skill.lockedBy)} aria-label={`${label}: ${text}, locked. ${lockText(skill.lockedBy)}`} data-testid="skills-lock">
        {text} · locked
      </span>
    );
  return (
    <button
      type="button"
      className="mr-2 h-8 shrink-0 rounded-md bg-secondary px-2.5 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 max-md:h-11 max-md:min-w-11"
      data-state={skill.state}
      title={`${stateHint(skill.state)}. Click to change.`}
      aria-label={`${label}: ${text}`}
      disabled={!!saving}
      onClick={() => onChange(skill)}
      data-testid="skills-state"
    >
      {saving === skill.name ? "Saving…" : text}
    </button>
  );
}
