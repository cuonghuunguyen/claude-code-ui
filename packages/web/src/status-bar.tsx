// Status bar under the prompt box: git branch + diff, session token totals, background shells. Model, context, mode and plan limits live in the prompt toolbar and titlebar.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import type { GitStatus } from "@claude-ui/protocol";
import { wholeParts, type SessionView, type ToolCall } from "./store.ts";

/** 453, 241.1k, 54.4M. */
export const tokens = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`);

/** `input`: uncached input + cache writes (status line In); `uncached`, `cacheWrite`, `cost` (sum of the known turn costs; `costPartial` when some turn has none): the context breakdown. */
export type Totals = { input: number; output: number; cached: number; uncached: number; cacheWrite: number; cost?: number; costPartial?: boolean };

/** Token totals of the session's turn results; undefined before the first one (also a restored transcript, which has none). */
export function totals(v: SessionView) {
  let t: Totals | undefined;
  for (const p of wholeParts(v)) {
    if (p.type !== "turn_result") continue;
    t ??= { input: 0, output: 0, cached: 0, uncached: 0, cacheWrite: 0 };
    t.input += p.usage.inputTokens + p.usage.cacheCreationTokens;
    t.output += p.usage.outputTokens;
    t.cached += p.usage.cacheReadTokens;
    t.uncached += p.usage.inputTokens;
    t.cacheWrite += p.usage.cacheCreationTokens;
    if (p.costUsd !== undefined) t.cost = (t.cost ?? 0) + p.costUsd;
    else t.costPartial = true;
  }
  if (t?.cost === undefined) delete t?.costPartial;
  return t;
}

/** Bash calls run with run_in_background whose task has not ended (task_notification). */
export const backgroundShells = (v: SessionView) =>
  wholeParts(v).filter(
    (p): p is ToolCall => p.type === "tool_call" && p.tool === "Bash" && p.status === "running" && (p.input as { run_in_background?: unknown }).run_in_background === true,
  );

// ponytail: polls git every 5s while shown; a daemon-side watcher if many tabs or big repos make it slow.
const GIT_POLL_MS = 5_000;

/** Changes of the cwd: on mount, at each session state change (turn end), and every GIT_POLL_MS for edits outside Claude. */
function useGit(git: (() => Promise<GitStatus | null>) | undefined, state: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  // A new function each parent render (streaming) must not refetch.
  const fn = useRef(git);
  fn.current = git;
  const on = !!git;
  useEffect(() => {
    if (!on) return;
    let live = true;
    const read = () => fn.current!().then((s) => live && setStatus(s), () => {});
    read();
    const t = setInterval(() => document.visibilityState === "visible" && read(), GIT_POLL_MS);
    return () => ((live = false), clearInterval(t));
  }, [on, state]);
  return status;
}

const TRIGGER =
  "cursor-pointer rounded-md px-1 -mx-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground min-h-6 pointer-coarse:min-h-11";

function Field({ field, children, popup, label }: { field: string; children: ReactNode; popup?: ReactNode; label?: string }) {
  const id = useId();
  if (!popup)
    return (
      <span data-field={field} className="flex items-center">
        {children}
      </span>
    );
  return (
    <Popover.Root>
      {/* The visible text stays the accessible name (WCAG 2.5.3); the label only describes the click. */}
      <Popover.Trigger data-field={field} aria-describedby={id} className={`flex items-center ${TRIGGER}`}>
        {children}
      </Popover.Trigger>
      <span id={id} hidden>
        {label}
      </span>
      {popup}
    </Popover.Root>
  );
}

export function StatusBar(props: { view: SessionView; git?: () => Promise<GitStatus | null> }) {
  const { view } = props;
  const sum = totals(view);
  const shells = backgroundShells(view);
  const git = useGit(props.git, view.state);
  // No field has data (outside a git repo before the first turn): no row.
  if (!git && !sum && !shells.length) return null;
  return (
    <div data-testid="status-bar" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-muted-foreground text-xs tabular-nums">
      {git && <Field field="branch">{git.branch}</Field>}
      {git && (
        <Field field="diff">
          (<span className="text-success">+{git.added}</span>,<span className="text-destructive">-{git.removed}</span>)
        </Field>
      )}
      {sum && <Field field="in">{`In: ${tokens(sum.input)}`}</Field>}
      {sum && <Field field="out">{`Out: ${tokens(sum.output)}`}</Field>}
      {sum && <Field field="cached">{`Cached: ${tokens(sum.cached)}`}</Field>}
      {shells.length > 0 && (
        <Field
          field="shells"
          label="Background shells, show list"
          popup={
            <Popover.Portal>
              <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50">
                <Popover.Popup
                  data-testid="shells"
                  className="w-72 max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
                >
                  <Popover.Title className="font-medium">Background shells</Popover.Title>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {shells.map((c) => {
                      const { command, description } = c.input as { command?: string; description?: string };
                      return (
                        <li key={c.id} className="flex flex-col text-xs" title={command}>
                          <span className="truncate">{description || command}</span>
                          {description && <code className="truncate text-muted-foreground">{command}</code>}
                        </li>
                      );
                    })}
                  </ul>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          }
        >
          {`${shells.length} shell${shells.length === 1 ? "" : "s"}`}
        </Field>
      )}
    </div>
  );
}
