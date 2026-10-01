// Status bar under the prompt box (Claude Code status line): model, context, git, tokens, plan limits, permission mode, background shells.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import type { GitStatus, PermissionMode, PlanUsage } from "@claude-ui/protocol";
import { ContextPopup } from "./context-meter.tsx";
import { PlanPopup } from "./plan-meter.tsx";
import type { SessionView, ToolCall } from "./store.ts";
import { Chooser, MODE_LABEL } from "./toolbar.tsx";

/** 453, 241.1k, 54.4M. */
export const tokens = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`);
const pct = (p: number) => `${p.toFixed(1)}%`;

/** 38m, 4hr 38m, 2d 14hr 58m. */
export function countdown(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const [d, h] = [Math.floor(m / 1440), Math.floor(m / 60) % 24];
  return d ? `${d}d ${h}hr ${m % 60}m` : h ? `${h}hr ${m % 60}m` : `${m % 60}m`;
}

/** Token totals of the session's turn results; undefined before the first one (also a restored transcript, which has none). */
export function totals(v: SessionView) {
  let t: { input: number; output: number; cached: number } | undefined;
  for (const id of v.order) {
    const p = v.parts.get(id)!;
    if (p.type !== "turn_result") continue;
    t ??= { input: 0, output: 0, cached: 0 };
    t.input += p.usage.inputTokens + p.usage.cacheCreationTokens;
    t.output += p.usage.outputTokens;
    t.cached += p.usage.cacheReadTokens;
  }
  return t;
}

/** Bash calls run with run_in_background whose task has not ended (task_notification). */
export const backgroundShells = (v: SessionView) =>
  [...v.parts.values()].filter(
    (p): p is ToolCall => p.type === "tool_call" && p.tool === "Bash" && p.status === "running" && (p.input as { run_in_background?: unknown }).run_in_background === true,
  );

/** Claude Code's footer wording; nothing in the default mode. */
const MODE_ON: Record<PermissionMode, string> = {
  default: "",
  acceptEdits: "accept edits on",
  plan: "plan mode on",
  bypassPermissions: "bypass permissions on",
  dontAsk: "don't ask on",
  auto: "auto mode on",
};

// ponytail: polls git every 5s while shown; a daemon-side watcher if many tabs or big repos make it slow.
const GIT_POLL_MS = 5_000;

function useNow(ms: number, on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

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

// Below sm only the fields in Claude Code's priority (model, ctx used, session) and the clickable shells stay.
const WIDE = "max-sm:hidden";
const TRIGGER =
  "cursor-pointer rounded-md px-1 -mx-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground min-h-6 pointer-coarse:min-h-11";

function Field({ field, children, wide = true, popup, label }: { field: string; children: ReactNode; wide?: boolean; popup?: ReactNode; label?: string }) {
  const cls = wide ? WIDE : "";
  const id = useId();
  if (!popup)
    return (
      <span data-field={field} className={`flex items-center ${cls}`}>
        {children}
      </span>
    );
  return (
    <Popover.Root>
      {/* The visible text stays the accessible name (WCAG 2.5.3); the label only describes the click. */}
      <Popover.Trigger data-field={field} aria-describedby={id} className={`flex items-center ${TRIGGER} ${cls}`}>
        {children}
      </Popover.Trigger>
      <span id={id} hidden>
        {label}
      </span>
      {popup}
    </Popover.Root>
  );
}

export function StatusBar(props: {
  view: SessionView;
  /** Display name of the session model. */
  model: string;
  mode: PermissionMode;
  modes: PermissionMode[];
  onMode: (mode: PermissionMode) => void;
  plan: PlanUsage | null;
  git?: () => Promise<GitStatus | null>;
}) {
  const { view, plan } = props;
  const usage = view.contextUsage;
  const sum = totals(view);
  const shells = backgroundShells(view);
  const session = plan?.windows.find((w) => w.kind === "session");
  const weekly = plan?.windows.find((w) => w.kind === "weekly_all");
  const now = useNow(15_000, !!(session?.resetsAt || weekly?.resetsAt));
  const git = useGit(props.git, view.state);
  const ctxPopup = usage && <ContextPopup usage={usage} side="top" />;
  const planPopup = plan && <PlanPopup usage={plan} side="top" />;
  const modes = props.modes.includes(props.mode) ? props.modes : [props.mode, ...props.modes];
  return (
    <div data-testid="status-bar" className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-muted-foreground text-xs tabular-nums">
      <Field field="model" wide={false}>{`Model: ${props.model}`}</Field>
      {usage && <Field field="ctx" popup={ctxPopup} label="Context window, show breakdown">{`Ctx: ${tokens(usage.totalTokens)}`}</Field>}
      {git && <Field field="branch">{git.branch}</Field>}
      {git && (
        <Field field="diff">
          (<span className="text-success">+{git.added}</span>,<span className="text-destructive">-{git.removed}</span>)
        </Field>
      )}
      {sum && <Field field="in">{`In: ${tokens(sum.input)}`}</Field>}
      {sum && <Field field="out">{`Out: ${tokens(sum.output)}`}</Field>}
      {sum && <Field field="cached">{`Cached: ${tokens(sum.cached)}`}</Field>}
      {usage && (
        <Field field="ctx-used" wide={false} popup={ctxPopup} label="Context window, show breakdown">
          {`Ctx Used: ${pct((usage.totalTokens / usage.maxTokens) * 100)}`}
        </Field>
      )}
      {session && (
        <Field field="session" wide={false} popup={planPopup} label="Plan usage, show details">
          {`Session: ${pct(session.percent)}`}
        </Field>
      )}
      {session?.resetsAt && (
        <Field field="session-reset" popup={planPopup} label="Plan usage, show details">
          {`Reset: ${countdown(session.resetsAt - now)}`}
        </Field>
      )}
      {weekly && (
        <Field field="weekly" popup={planPopup} label="Plan usage, show details">
          {`Weekly: ${pct(weekly.percent)}`}
        </Field>
      )}
      {weekly?.resetsAt && (
        <Field field="weekly-reset" popup={planPopup} label="Plan usage, show details">
          {`Weekly Reset: ${countdown(weekly.resetsAt - now)}`}
        </Field>
      )}
      {MODE_ON[props.mode] && (
        <span data-field="mode" className={`contents ${WIDE}`}>
          <Chooser
            label="Permission mode"
            testId="status-mode"
            value={props.mode}
            onChange={props.onMode}
            items={modes.map((m) => ({ value: m, label: MODE_LABEL[m].label, trigger: MODE_ON[m] }))}
            className="h-auto! min-h-6 px-1! py-0! -mx-1 max-sm:hidden pointer-coarse:min-h-11 [&>svg:last-child]:hidden"
          />
        </span>
      )}
      {shells.length > 0 && (
        <Field
          field="shells"
          wide={false}
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
