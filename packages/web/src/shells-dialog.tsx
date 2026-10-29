// Shells list (GH-442, Claude Code /tasks): the session's background shells; one shell's output (live while it runs) and Kill.
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import type { ShellOutputResult } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { duration, useNow } from "./agents.tsx";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { ConfirmDialog } from "./session-actions.tsx";
import { isRunningShell, SHELL_STATUS, shellInput, shellsOf } from "./shells.ts";
import type { SessionView, ToolCall } from "./store.ts";
import { ToolBody } from "./tool-card.tsx";

// shortcut: polls the output file every second while shown; a daemon file watch if many viewers make it heavy.
const SHELL_POLL_MS = 1000;

const ROW = "flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11";

const label = (c: ToolCall) => shellInput(c).description || shellInput(c).command || "Bash";
const runTime = (c: ToolCall, now: number) => (c.startedAt === undefined ? undefined : duration((c.endedAt ?? now) - c.startedAt));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Output({ call, output }: { call: ToolCall; output: (toolUseId: string) => Promise<ShellOutputResult> }) {
  const running = isRunningShell(call);
  const [out, setOut] = useState<ShellOutputResult>();
  const [error, setError] = useState<string>();
  const ask = useRef(output);
  ask.current = output;
  // An older answer must not replace a newer one.
  const sent = useRef(0);
  const shown = useRef(0);
  useEffect(() => {
    const read = () => {
      const n = ++sent.current;
      ask.current(call.toolUseId).then(
        (r) => n > shown.current && ((shown.current = n), setError(undefined), setOut(r)),
        (e) => n > shown.current && ((shown.current = n), setError(message(e))),
      );
    };
    read();
    // While it runs: every second; the effect runs once more when it ends (the final read).
    if (!running) return;
    const t = setInterval(read, SHELL_POLL_MS);
    return () => clearInterval(t);
  }, [call.toolUseId, running]);
  return (
    <>
      {error && <Banner kind="error">Output not available: {error}</Banner>}
      {!out && !error && <Skeleton className="h-16 w-full" />}
      {out && (
        <div data-testid="shell-output" className="space-y-1">
          {out.truncated && <p className="text-muted-foreground text-xs">Showing the last 30,000 characters.</p>}
          <ToolBody call={call} result={{ type: "tool_result", id: `${call.id}:result`, toolUseId: call.toolUseId, output: out.output, isError: call.status === "error" }} tail />
        </div>
      )}
    </>
  );
}

export function ShellsDialog({
  open,
  view,
  output,
  kill,
  onClose,
}: {
  open: boolean;
  view?: SessionView;
  onClose: () => void;
  output: (toolUseId: string) => Promise<ShellOutputResult>;
  kill: (toolUseId: string) => Promise<unknown>;
}) {
  const [selected, setSelected] = useState<string>();
  const [confirm, setConfirm] = useState(false);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<string>();
  // The shells this dialog killed: the CLI starts no turn for a killed shell, Claude is told with the next message.
  const [told, setTold] = useState<string[]>([]);
  const shells = view ? shellsOf(view) : [];
  const call = shells.find((c) => c.toolUseId === selected);
  const now = useNow(open && shells.some(isRunningShell));
  useEffect(() => {
    if (open) return;
    setSelected(undefined);
    setConfirm(false);
  }, [open]);
  const running = !!call && isRunningShell(call);
  // Killing ends when the part leaves running (the CLI's notification) or the request fails.
  useEffect(() => {
    if (!running) setKilling(false);
  }, [running]);
  const select = (id?: string) => (setSelected(id), setKilling(false), setKillError(undefined));
  return (
    <ConfigDialog title="Background shells" open={open} onClose={onClose} testId="shells-dialog">
      {!call && !shells.length && (
        <p data-testid="shells-empty" className="text-muted-foreground text-sm">
          No background shells in this session.
        </p>
      )}
      {!call && shells.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {shells.map((c) => {
            const { command, description } = shellInput(c);
            const time = runTime(c, now);
            return (
              <li key={c.id}>
                <button type="button" data-testid="shell-row" data-status={c.status} className={ROW} onClick={() => select(c.toolUseId)}>
                  <span className="flex min-w-0 flex-1 flex-col text-sm" title={command}>
                    <span className="truncate">{label(c)}</span>
                    {description && <code className="truncate text-muted-foreground text-xs">{command}</code>}
                    <span className="text-muted-foreground text-xs">
                      {SHELL_STATUS[c.status]}
                      {c.exitCode !== undefined && ` · exit ${c.exitCode}`}
                    </span>
                  </span>
                  {time && <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{time}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {selected && !call && (
        <>
          <Button variant="ghost" onClick={() => select(undefined)}>
            Back to shells
          </Button>
          <p className="text-muted-foreground text-sm">This shell is not in the session any more.</p>
        </>
      )}
      {call && (
        <>
          <div className="flex items-center gap-2">
            <button type="button" aria-label="Back to shells" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:size-11" onClick={() => select(undefined)}>
              <ArrowLeftIcon aria-hidden className="size-4" />
            </button>
            <span className="min-w-0 flex-1 truncate font-medium text-sm">{label(call)}</span>
            {running && (
              <Button variant="destructive" data-testid="shell-kill" disabled={killing} className="max-md:h-11" onClick={() => setConfirm(true)}>
                {killing ? "Killing…" : "Kill"}
              </Button>
            )}
          </div>
          <div data-testid="shell-meta" className="text-muted-foreground text-xs tabular-nums">
            {SHELL_STATUS[call.status]}
            {call.exitCode !== undefined && ` · exit code ${call.exitCode}`}
            {runTime(call, now) && ` · ${runTime(call, now)}`}
            {!running && told.includes(call.toolUseId) && (
              <span data-testid="shell-told" className="block">
                Claude will be told on your next message.
              </span>
            )}
          </div>
          {killError && <Banner kind="error">Could not kill: {killError}</Banner>}
          <Output call={call} output={output} />
          <ConfirmDialog
            open={confirm}
            title="Kill shell?"
            description={`"${shellInput(call).command ?? ""}" stops now. Claude gets notified.`}
            confirm="Kill"
            destructive
            testId="shell-kill"
            onCancel={() => setConfirm(false)}
            onConfirm={() => {
              setConfirm(false);
              setKilling(true);
              setKillError(undefined);
              kill(call.toolUseId).then(() => setTold((t) => [...t, call.toolUseId]), (e) => (setKilling(false), setKillError(message(e))));
            }}
          />
        </>
      )}
    </ConfigDialog>
  );
}
