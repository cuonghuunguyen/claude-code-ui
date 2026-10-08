// Settings dialog (docs/spec.md "Settings"): app-wide, daemon-side settings in sections, on the ConfigDialog shell,
// plus per-browser choices (Changes, Tabs) that never reach the daemon.
// A later setting is one more row in SECTIONS; reading, patching, errors and layout stay as they are.
import { useEffect, useRef, useState } from "react";
import type { Settings, SettingsPatch, SettingsResult } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { isImeKey } from "./ime.ts";
import { Switch } from "./plugins-dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DIFF_MODES, saveDiffMode, useDefaultDiffMode, type DiffMode } from "./diff-mode.ts";
import { TAB_GROUPINGS, type TabGrouping } from "./tab-grouping.ts";

type Row = { key: string; label: string; hint: string } & ({ kind: "switch" } | { kind: "number"; min: number; max: number } | { kind: "select"; options: { value: string; label: string }[] });
const SECTIONS: { id: keyof Settings; title: string; rows: Row[] }[] = [
  {
    id: "orchestration",
    title: "Orchestration",
    rows: [
      { key: "enabled", kind: "switch", label: "Enable orchestration", hint: "Every session (except workers) may start and supervise worker sessions. Applies at a session's next start." },
      { key: "workerCap", kind: "number", min: 1, max: 20, label: "Maximum workers", hint: "Worker sessions running at the same time (1 to 20)." },
      {
        key: "workerMode",
        kind: "select",
        label: "Worker mode",
        hint: "Permission mode of a new worker when the coordinator does not name one. Coordinator's mode: the coordinator's own (bypass gives auto). A mode above the coordinator's still asks you on the worker_start card.",
        options: [
          { value: "coordinator", label: "Coordinator's mode" },
          { value: "default", label: "Default" },
          { value: "acceptEdits", label: "Accept edits" },
          { value: "plan", label: "Plan" },
          { value: "auto", label: "Auto" },
        ],
      },
      { key: "coordinatorPermissions", kind: "switch", label: "Coordinator may answer permission requests", hint: "Allows the coordinator to approve or deny, once, reads and file edits inside the worker folder, reads of the repository's main checkout and agent docs (.claude/skills, CLAUDE.md), and read-only git commands (status, log, diff, show). Other commands and everything else wait for you; no permission rule is saved. Edits can change code that commands you approve later will run." },
    ],
  },
  {
    id: "usageLimit",
    title: "Usage limits",
    rows: [
      { key: "autoContinue", kind: "switch", label: "Continue automatically after a usage limit resets", hint: "A session stopped by the plan usage limit gets the prompt “continue” once the limit resets; several sessions continue one after another. Sending a message yourself cancels it. A daemon restart drops scheduled continues." },
    ],
  },
];

/** `changed`: bumped when another client changed the settings (reloads them). */
export function SettingsDialog({ open, changed = 0, request, onClose, tabGrouping, onTabGrouping }: { open: boolean; changed?: number; request: <T>(msg: Request) => Promise<T>; onClose: () => void; tabGrouping?: TabGrouping; onTabGrouping?: (g: TabGrouping) => void }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  // The number field's text while typing; committed on Enter or blur.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const diffMode = useDefaultDiffMode();
  const ask = useRef(request);
  ask.current = request;

  useEffect(() => {
    if (!open) return;
    let live = true;
    ask.current<SettingsResult>({ type: "settings.get" }).then(
      (r) => live && (setSettings(r.settings), setError(undefined), setDraft({})),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [open, changed]);

  const save = async (patch: SettingsPatch, field?: string) => {
    setSaving(true);
    try {
      setSettings((await ask.current<SettingsResult>({ type: "settings.set", patch })).settings);
      setError(undefined);
      if (field) setDraft(({ [field]: _, ...rest }) => rest);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigDialog title="Settings" open={open} onClose={onClose} testId="settings-dialog">
      {error && <Banner kind="error">{error}</Banner>}
      <section aria-labelledby="settings-changes" className="flex flex-col" data-testid="settings-changes">
        <h3 id="settings-changes" className="pb-1 font-medium text-[13px] text-muted-foreground">
          Changes
        </h3>
        <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
          <div className="min-w-0 flex-1">
            <span id="settings-changes-mode-label" className="block text-sm">Default diff view</span>
            <span id="settings-changes-mode-hint" className="block text-muted-foreground text-xs">The mode the Changes panel opens in. A choice in a session's panel lasts for that session until the page reloads. Kept in this browser.</span>
          </div>
          <Select value={diffMode} onValueChange={(v) => v && saveDiffMode(v as DiffMode)}>
            <SelectTrigger aria-labelledby="settings-changes-mode-label" aria-describedby="settings-changes-mode-hint" data-testid="settings-diff-mode" className="w-40 max-md:data-[size=default]:h-11">
              <SelectValue>{(v: DiffMode) => DIFF_MODES.find((m) => m.value === v)?.label ?? v}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {DIFF_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value} data-testid={`settings-diff-mode-${m.value}`}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </section>
      {onTabGrouping && (
        <section aria-labelledby="settings-tabs" className="flex flex-col" data-testid="settings-tabs">
          <h3 id="settings-tabs" className="pb-1 font-medium text-[13px] text-muted-foreground">
            Tabs
          </h3>
          <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
            <div className="min-w-0 flex-1">
              <span id="settings-tabs-grouping-label" className="block text-sm">Tab grouping</span>
              <span id="settings-tabs-grouping-hint" className="block text-muted-foreground text-xs">How the tab bar groups open tabs. Kept in this browser.</span>
            </div>
            <Select value={tabGrouping ?? "project"} onValueChange={(v) => v && onTabGrouping(v as TabGrouping)}>
              <SelectTrigger aria-labelledby="settings-tabs-grouping-label" aria-describedby="settings-tabs-grouping-hint" data-testid="settings-tabs-grouping" className="w-36 max-md:data-[size=default]:h-11">
                <SelectValue>{(v: TabGrouping) => TAB_GROUPINGS.find((g) => g.value === v)?.label ?? v}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TAB_GROUPINGS.map((g) => (
                  <SelectItem key={g.value} value={g.value} data-testid={`settings-tabs-grouping-${g.value}`}>
                    {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>
      )}
      {!settings && !error && <p className="text-muted-foreground text-sm">Loading…</p>}
      {settings &&
        SECTIONS.map((sec) => (
          <section key={sec.id} aria-labelledby={`settings-${sec.id}`} className="flex flex-col" data-testid={`settings-${sec.id}`}>
            <h3 id={`settings-${sec.id}`} className="pb-1 font-medium text-[13px] text-muted-foreground">
              {sec.title}
            </h3>
            {sec.rows.map((row) => {
              const id = `settings-${sec.id}-${row.key}`;
              const value = (settings[sec.id] as Record<string, unknown>)[row.key];
              const patch = (v: unknown) => ({ [sec.id]: { [row.key]: v } }) as SettingsPatch;
              return (
                <div key={row.key} className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
                  <div className="min-w-0 flex-1">
                    <label htmlFor={id} className="block text-sm">{row.label}</label>
                    <span id={`${id}-hint`} className="block text-muted-foreground text-xs">{row.hint}</span>
                  </div>
                  {row.kind === "switch" ? (
                    <Switch on={value === true} label={row.label} held={saving} onToggle={(on) => void save(patch(on))} title={row.label} describedBy={`${id}-hint`} testId={id} />
                  ) : row.kind === "select" ? (
                    <Select value={String(value)} onValueChange={(v) => v && void save(patch(v))}>
                      <SelectTrigger id={id} aria-describedby={`${id}-hint`} aria-label={row.label} data-testid={id} className="w-44 max-md:data-[size=default]:h-11">
                        <SelectValue>{(v: string) => row.options.find((o) => o.value === v)?.label ?? v}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {row.options.map((o) => (
                          <SelectItem key={o.value} value={o.value} data-testid={`${id}-${o.value}`}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <input
                      id={id}
                      aria-describedby={`${id}-hint`}
                      type="number"
                      inputMode="numeric"
                      min={row.min}
                      max={row.max}
                      step={1}
                      value={draft[id] ?? String(value)}
                      onChange={(e) => setDraft((d) => ({ ...d, [id]: e.target.value }))}
                      onBlur={() => id in draft && void save(patch(draft[id] === "" ? NaN : Number(draft[id])), id)}
                      onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && e.currentTarget.blur()}
                      className="h-8 w-16 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
                      data-testid={id}
                    />
                  )}
                </div>
              );
            })}
          </section>
        ))}
    </ConfigDialog>
  );
}
