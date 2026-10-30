// Keyboard shortcuts dialog (docs/spec.md "Keyboard shortcuts"): every shortcut by group, a filter, and a recorder to rebind one (per browser).
import { useEffect, useRef, useState } from "react";
import { ConfigDialog } from "./config-dialog.tsx";
import { bind, bindingError, conflictOf, isChanged, pressError, resetAll, resetBinding, specFromEvent, specOf, useKeymap } from "./keymap.ts";
import { PREFIX_KEYS } from "./leader.ts";
import { FORMAT_KEYS } from "./markdown-toolbar.tsx";
import { IS_MAC, SHORTCUTS, keyLabels, shortcutById, type ShortcutGroup } from "./shortcuts.ts";
import { groupTitle, prefixTitle, shortcutTitle } from "./shortcut-titles.ts";
import { useT, type Key } from "./i18n.ts";

const GROUPS: ShortcutGroup[] = ["General", "Tabs", "Panels", "Session", "Prefix"];

const Chips = ({ spec }: { spec?: string }) => {
  const t = useT();
  return spec ? (
    <kbd className="flex shrink-0 gap-0.5 font-sans">
      {keyLabels(spec).map((k, i) => (
        <span key={i} className="grid h-5 min-w-5 place-items-center rounded-xs bg-kbd px-1 font-medium text-[11px] text-muted-foreground uppercase leading-none">
          {k}
        </span>
      ))}
    </kbd>
  ) : (
    <span className="text-faint text-xs">{t("shortcuts.notSet")}</span>
  );
};

const btn = "rounded-md px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:min-w-11 h-7";

/** Fixed keys of other places: shown, not editable. */
const FIXED: { title: Key; spec: string }[] = [
  { title: "shortcuts.fixed.stop", spec: "escape" },
  { title: "shortcuts.fixed.mode", spec: "shift+tab" },
];

export function ShortcutsDialog({ open, onClose, edit }: { open: boolean; onClose: () => void; /** Opens recording on this command's row (the key promoter's "Assign a shortcut…"). */ edit?: string }) {
  const t = useT();
  useKeymap();
  const [filter, setFilter] = useState("");
  const [recording, setRecording] = useState<string>();
  const [pending, setPending] = useState<{ id: string; spec: string; with: { id?: string; title: string } }>();
  const [error, setError] = useState<string>();

  const filterRef = useRef<HTMLInputElement>(null);
  const editRefs = useRef(new Map<string, HTMLButtonElement>());
  // The filter (or the Edit button of the command to assign) takes the focus once when the dialog opens (after the dialog's own focus move), not on each render.
  useEffect(() => {
    if (!open) return;
    if (edit && shortcutById(edit)) setRecording(edit);
    const t = setTimeout(() => {
      const b = edit ? editRefs.current.get(edit) : undefined;
      if (b) (b.scrollIntoView?.({ block: "nearest" }), b.focus());
      else filterRef.current?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open, edit]);

  const stop = () => (setRecording(undefined), setPending(undefined), setError(undefined));

  // Reset, Replace and Cancel unmount the focused button: the focus moves to the row's Edit button, or the filter when the row is filtered out.
  const [refocus, setRefocus] = useState<string>();
  useEffect(() => {
    if (!refocus) return;
    (editRefs.current.get(refocus) ?? filterRef.current)?.focus();
    setRefocus(undefined);
  }, [refocus]);
  useEffect(() => {
    if (!open) (stop(), setFilter(""));
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
      const bad = pressError(e) ?? bindingError(spec);
      if (bad) return (setPending(undefined), setError(bad));
      const clash = conflictOf(recording, spec, IS_MAC, e);
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
      title={t("shortcuts.title")}
      open={open}
      onClose={onClose}
      testId="shortcuts-dialog"
      footer={
        <>
          <span className="flex-1 text-muted-foreground text-xs">{t("shortcuts.kept")}</span>
          <button type="button" className={`${btn} border`} onClick={() => (resetAll(), stop())} data-testid="shortcuts-reset-all">
            {t("shortcuts.resetAll")}
          </button>
        </>
      }
    >
      <input
        type="search"
        ref={filterRef}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t("shortcuts.filter")}
        aria-label={t("shortcuts.filterLabel")}
        className="h-8 shrink-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
        data-testid="shortcuts-filter"
      />
      {GROUPS.map((g) =>
        section(
          groupTitle(g),
          [
            ...SHORTCUTS.filter((s) => s.group === g && shows(shortcutTitle(s.id), specOf(s.id))).map((s) => (
              <div key={s.id} className={`${rowClass} flex-wrap`} data-testid={`shortcut-row-${s.id}`}>
                <span className="min-w-0 flex-1 text-sm">{shortcutTitle(s.id)}</span>
                {recording === s.id ? (
                  <span role="status" className="text-sm" data-testid="shortcut-recording">
                    {t("shortcuts.recording")}
                  </span>
                ) : (
                  <Chips spec={specOf(s.id)} />
                )}
                <button
                  type="button"
                  ref={(b) => void (b ? editRefs.current.set(s.id, b) : editRefs.current.delete(s.id))}
                  className={btn}
                  onClick={() => (stop(), setRecording(s.id))}
                  aria-label={t("shortcuts.editLabel", { title: shortcutTitle(s.id) })} data-testid={`shortcut-edit-${s.id}`}>
                  {t("shortcuts.edit")}
                </button>
                {isChanged(s.id) && (
                  <button type="button" className={btn} onClick={() => (resetBinding(s.id), stop(), setRefocus(s.id))} aria-label={t("shortcuts.resetLabel", { title: shortcutTitle(s.id) })} data-testid={`shortcut-reset-${s.id}`}>
                    {t("shortcuts.reset")}
                  </button>
                )}
                {recording === s.id && error && (
                  <p role="alert" className="basis-full text-destructive text-xs" data-testid="shortcut-error">
                    {error}
                  </p>
                )}
                {pending?.id === s.id && (
                  <p role="alert" className="flex basis-full flex-wrap items-center gap-2 text-xs" data-testid="shortcut-conflict">
                    <span className="flex-1">{t("shortcuts.usedBy", { title: pending.with.title })}</span>
                    {pending.with.id && (
                      <button
                        type="button"
                        className={`${btn} border`}
                        onClick={() => (bind(pending.with.id!, null), bind(pending.id, pending.spec), stop(), setRefocus(pending.id))}
                        data-testid="shortcut-replace"
                      >
                        {t("shortcuts.replace")}
                      </button>
                    )}
                    <button type="button" className={`${btn} border`} onClick={() => (stop(), setRefocus(pending.id))} data-testid="shortcut-cancel">
                      {t("shortcuts.cancel")}
                    </button>
                  </p>
                )}
              </div>
            )),
            ...(g === "Prefix"
              ? PREFIX_KEYS.filter((p) => shows(prefixTitle(p.id), p.key)).map((p) => (
                  <div key={p.key} className={rowClass}>
                    <span className="min-w-0 flex-1 text-sm">{prefixTitle(p.id)}</span>
                    <span className="text-faint text-xs">{t("shortcuts.then")}</span>
                    <Chips spec={p.key === "1-9" ? "1-9" : p.key} />
                  </div>
                ))
              : []),
          ],
        ),
      )}
      {section(
        t("shortcuts.inPrompt"),
        (Object.entries(FORMAT_KEYS) as [keyof typeof FORMAT_KEYS, string][])
          .filter(([name, spec]) => shows(t(`shortcuts.format.${name}`), spec))
          .map(([name, spec]) => (
            <div key={name} className={rowClass}>
              <span className="min-w-0 flex-1 text-sm capitalize">{t(`shortcuts.format.${name}`)}</span>
              <Chips spec={spec} />
            </div>
          )),
      )}
      {section(
        t("shortcuts.fixed"),
        FIXED.filter((f) => shows(t(f.title), f.spec)).map((f) => (
          <div key={f.title} className={rowClass}>
            <span className="min-w-0 flex-1 text-sm">{t(f.title)}</span>
            <Chips spec={f.spec} />
          </div>
        )),
      )}
    </ConfigDialog>
  );
}
