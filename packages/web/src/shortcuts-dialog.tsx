// Keyboard shortcuts dialog (docs/spec.md "Keyboard shortcuts"): every shortcut by group, a filter, and a recorder to rebind one (per browser).
import { useEffect, useState } from "react";
import { ConfigDialog } from "./config-dialog.tsx";
import { bind, bindingError, conflictOf, isChanged, resetAll, resetBinding, specFromEvent, specOf, useKeymap } from "./keymap.ts";
import { PREFIX_KEYS } from "./leader.ts";
import { FORMAT_KEYS } from "./markdown-toolbar.tsx";
import { SHORTCUTS, keyLabels, type ShortcutGroup } from "./shortcuts.ts";

const GROUPS: ShortcutGroup[] = ["General", "Tabs", "Panels", "Session", "Prefix"];
const GROUP_TITLE: Record<ShortcutGroup, string> = { General: "General", Tabs: "Tabs", Panels: "Panels", Session: "Session", Prefix: "Prefix key" };

const Chips = ({ spec }: { spec?: string }) =>
  spec ? (
    <kbd className="flex shrink-0 gap-0.5 font-sans">
      {keyLabels(spec).map((k, i) => (
        <span key={i} className="grid h-5 min-w-5 place-items-center rounded-xs bg-kbd px-1 font-medium text-[11px] text-muted-foreground uppercase leading-none">
          {k}
        </span>
      ))}
    </kbd>
  ) : (
    <span className="text-faint text-xs">Not set</span>
  );

const btn = "rounded-md px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:min-w-11 h-7";

/** Fixed keys of other places: shown, not editable. */
const FIXED: { title: string; spec: string }[] = [
  { title: "Stop the running turn", spec: "escape" },
  { title: "Change permission mode (prompt box)", spec: "shift+tab" },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useKeymap();
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<string>();
  const [pending, setPending] = useState<{ id: string; spec: string; with: { id?: string; title: string } }>();
  const [error, setError] = useState<string>();

  const stop = () => (setRecording(undefined), setPending(undefined), setError(undefined));
  useEffect(() => {
    if (!open) stop();
  }, [open]);

  // The recorder takes the next key press before the dialog or the app sees it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      const spec = specFromEvent(e);
      if (!spec) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (spec === "escape") return stop();
      if (spec === "backspace" || spec === "delete") return (bind(recording, null), stop());
      const bad = bindingError(spec);
      if (bad) return (setPending(undefined), setError(bad));
      const clash = conflictOf(recording, spec);
      // A prompt box key cannot be taken over; another shortcut can (Replace).
      if (clash) return (setError(undefined), setPending({ id: recording, spec, with: clash }));
      bind(recording, spec);
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const q = filter.trim().toLowerCase();
  const shows = (title: string, spec?: string) => !q || title.toLowerCase().includes(q) || (!!spec && keyLabels(spec, false).join("+").toLowerCase().includes(q)) || (!!spec && keyLabels(spec).join("").toLowerCase().includes(q));
  const rowClass = "flex min-h-9 items-center gap-2 border-t py-1 max-md:min-h-11";

  const section = (title: string, rows: React.ReactNode[]) =>
    rows.length > 0 && (
      <section key={title} aria-label={title} className="flex flex-col">
        <h3 className="pb-1 font-medium text-[13px] text-muted-foreground">{title}</h3>
        {rows}
      </section>
    );

  return (
    <ConfigDialog
      title="Keyboard shortcuts"
      open={open}
      onClose={onClose}
      testId="shortcuts-dialog"
      footer={
        <>
          <span className="flex-1 text-muted-foreground text-xs">Kept in this browser.</span>
          <button type="button" className={`${btn} border`} onClick={() => (resetAll(), stop())} data-testid="shortcuts-reset-all">
            Reset all
          </button>
        </>
      }
    >
      <input
        type="search"
        // The filter takes the focus on open (after the dialog's own focus move).
        ref={(n) => void (n && setTimeout(() => n.isConnected && n.focus(), 0))}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by name or key"
        aria-label="Filter shortcuts"
        className="h-8 shrink-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
        data-testid="shortcuts-filter"
      />
      {GROUPS.map((g) =>
        section(
          GROUP_TITLE[g],
          [
            ...SHORTCUTS.filter((s) => s.group === g && shows(s.title, specOf(s.id))).map((s) => (
              <div key={s.id} className={`${rowClass} flex-wrap`} data-testid={`shortcut-row-${s.id}`}>
                <span className="min-w-0 flex-1 text-sm">{s.title}</span>
                {recording === s.id ? (
                  <span role="status" className="text-sm" data-testid="shortcut-recording">
                    Press keys… (Esc cancels, Backspace removes)
                  </span>
                ) : (
                  <Chips spec={specOf(s.id)} />
                )}
                <button type="button" className={btn} onClick={() => (stop(), setRecording(s.id))} aria-label={`Edit ${s.title}`} data-testid={`shortcut-edit-${s.id}`}>
                  Edit
                </button>
                {isChanged(s.id) && (
                  <button type="button" className={btn} onClick={() => (resetBinding(s.id), stop())} aria-label={`Reset ${s.title}`} data-testid={`shortcut-reset-${s.id}`}>
                    Reset
                  </button>
                )}
                {recording === s.id && error && (
                  <p role="alert" className="basis-full text-destructive text-xs" data-testid="shortcut-error">
                    {error}
                  </p>
                )}
                {pending?.id === s.id && (
                  <p role="alert" className="flex basis-full flex-wrap items-center gap-2 text-xs" data-testid="shortcut-conflict">
                    <span className="flex-1">Already used by {pending.with.title}</span>
                    {pending.with.id && (
                      <button
                        type="button"
                        className={`${btn} border`}
                        onClick={() => (bind(pending.with.id!, null), bind(pending.id, pending.spec), stop())}
                        data-testid="shortcut-replace"
                      >
                        Replace
                      </button>
                    )}
                    <button type="button" className={`${btn} border`} onClick={stop} data-testid="shortcut-cancel">
                      Cancel
                    </button>
                  </p>
                )}
              </div>
            )),
            ...(g === "Prefix"
              ? PREFIX_KEYS.filter((p) => shows(p.title, p.key)).map((p) => (
                  <div key={p.key} className={rowClass}>
                    <span className="min-w-0 flex-1 text-sm">{p.title}</span>
                    <span className="text-faint text-xs">then</span>
                    <Chips spec={p.key === "1-9" ? "1-9" : p.key} />
                  </div>
                ))
              : []),
          ],
        ),
      )}
      {section(
        "In the prompt box",
        Object.entries(FORMAT_KEYS)
          .filter(([name, spec]) => shows(name, spec))
          .map(([name, spec]) => (
            <div key={name} className={rowClass}>
              <span className="min-w-0 flex-1 text-sm capitalize">{name}</span>
              <Chips spec={spec} />
            </div>
          )),
      )}
      {section(
        "Fixed",
        FIXED.filter((f) => shows(f.title, f.spec)).map((f) => (
          <div key={f.title} className={rowClass}>
            <span className="min-w-0 flex-1 text-sm">{f.title}</span>
            <Chips spec={f.spec} />
          </div>
        )),
      )}
    </ConfigDialog>
  );
}
