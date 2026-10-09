// The panel of a WSL distro or Docker container that is not ready (Open project): the read-only check result, the one action
// (Install, Update, Start, Reinstall, Install anyway) and the progress or the failure of that action. It never starts anything
// by itself: the owner calls onRun when a button is pressed (docs/spec.md "Sides").
import { useEffect, useRef, useState } from "react";
import { CheckIcon, LoaderCircleIcon, MinusIcon, TriangleAlertIcon } from "lucide-react";
import type { SideInfo } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { SideCheck, SidePhase, SideSetup } from "./side-check-types.ts";

/** What a button asks `side.start` for: a setup mode, or "plain" (a daemon without side.check: no setup field). */
export type RunMode = SideSetup | "plain";

/** What the dialog knows about one side's panel. */
export type PanelState = {
  checking?: boolean;
  check?: SideCheck;
  /** The daemon is older than this page: it cannot check (unknown_type). */
  legacy?: boolean;
  /** The check itself failed (timeout, disconnect). */
  checkError?: string;
  /** A `side.start` from this dialog is running. */
  busy?: { mode: RunMode };
  /** The last start failed: its message and the mode to retry. */
  error?: string;
  failed?: RunMode;
};

const PHASE_TEXT: Record<SidePhase, string> = {
  packing: "Packing claude-ui…",
  copying: "Copying into the container…",
  installing: "Installing (npm, can take minutes)…",
  starting: "Starting…",
};

const VERDICT_TEXT: Record<SideCheck["verdict"], string> = {
  running: "Running.",
  starting: "Starting…",
  installed: "claude-ui is installed. Start it to open folders.",
  install: "claude-ui is not installed here yet.",
  update: "An older claude-ui is installed. Update it to match this one.",
  blocked: "This side cannot be set up yet.",
};

/** The fix per reason, used when the daemon sent no message. */
function fixText(check: SideCheck, label: string): string | undefined {
  if (check.message) return check.message;
  const f = check.facts;
  switch (check.reason) {
    case "gone":
      return `${label} no longer exists. Pick another one.`;
    case "not_running":
      return `${label} is not running. Start it, then check again.`;
    case "unreachable":
      return `${label} cannot be reached. Make sure it works, then check again.`;
    case "no_build":
      return "claude-ui has no finished build to install. Wait for the build to finish, then check again.";
    case "package_unreadable":
      return "claude-ui cannot read its own files to install them. Wait for the build to finish, then check again.";
    case "node_missing":
      return `Node.js 22 or newer is not installed in ${label}. Install it there (for example nvm install 22), then check again.`;
    case "node_old":
      return `Node.js ${f.node ?? ""} in ${label} is too old. Install version 22 or newer, then check again.`;
    case "build_tools_missing":
      return `Build tools are missing in ${label}: ${missingTools(f.buildTools).join(", ")}. Install them, then check again.`;
    case "not_logged_in":
      return `No Claude login found in ${label}. Log in there (run claude), then check again. If you log in with an environment variable, use Install anyway.`;
    case "no_writable_path":
      return `${label} has no writable folder. Mount a tmpfs on /tmp, then check again.`;
    case "check_failed":
      return "The check did not finish. Check again.";
    default:
      return undefined;
  }
}

const missingTools = (t?: { make: boolean; python3: boolean; cxx: boolean }) => (t ? ([!t.make && "make", !t.python3 && "python3", !t.cxx && "g++"].filter(Boolean) as string[]) : []);

type Row = { name: string; value: string; status: "ok" | "missing" | "na" };
function rowsOf(c: SideCheck): Row[] {
  const f = c.facts;
  const na = (name: string): Row => ({ name, value: "Not checked", status: "na" });
  if (!f.reachable) return [{ name: "Reachable", value: "No", status: "missing" }, na("Node.js 22+"), na("Build tools"), na("Claude login"), na("claude-ui for this build")];
  const tools = missingTools(f.buildTools);
  return [
    { name: "Reachable", value: f.running ? "Yes, running" : "Yes", status: "ok" },
    f.node === undefined && f.nodeOk === undefined ? na("Node.js 22+") : f.node && f.nodeOk ? { name: "Node.js 22+", value: f.node, status: "ok" } : { name: "Node.js 22+", value: f.node ? `${f.node} (too old)` : "Not installed", status: "missing" },
    !f.buildTools ? na("Build tools") : tools.length ? { name: "Build tools", value: `Missing: ${tools.join(", ")}`, status: "missing" } : { name: "Build tools", value: "Found", status: "ok" },
    f.credentialsFile === undefined ? na("Claude login") : f.credentialsFile ? { name: "Claude login", value: "Found", status: "ok" } : { name: "Claude login", value: "Not found", status: "missing" },
    f.installed === "current" ? { name: "claude-ui for this build", value: "Installed", status: "ok" } : f.installed === "other" ? { name: "claude-ui for this build", value: "Older build installed", status: "missing" } : { name: "claude-ui for this build", value: "Not installed", status: "missing" },
  ];
}

/** The one main button for a check result, or none when the side is blocked. */
export function actionOf(check: SideCheck, failed: boolean): { label: string; mode: SideSetup } | undefined {
  const v = check.verdict;
  if (check.reason === "not_logged_in" && (v === "blocked" || v === "install" || v === "update")) return { label: "Install anyway", mode: "needed" };
  if (v === "blocked" || v === "running" || v === "starting") return undefined;
  if (failed) return { label: "Reinstall", mode: "force" };
  return v === "install" ? { label: "Install", mode: "needed" } : v === "update" ? { label: "Update", mode: "needed" } : { label: "Start", mode: "never" };
}

function Elapsed() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setS((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return <span data-testid="side-elapsed">{s} s</span>;
}

export function SidePanel({
  side,
  state,
  onRun,
  onCheck,
}: {
  side: SideInfo & { phase?: SidePhase };
  state: PanelState;
  onRun: (mode: RunMode) => void;
  onCheck: () => void;
}) {
  const { label } = side;
  const retry = useRef<HTMLButtonElement>(null);
  const error = state.error ?? (side.state === "error" ? (side.message ?? `${label} is not running.`) : undefined);
  const failed = state.failed ?? (side.state === "error" ? "needed" : undefined);
  const inProgress = !!state.busy || side.state === "starting";
  const mode = state.busy?.mode ?? "needed";
  const phase = side.phase ?? (state.check?.verdict === "starting" ? state.check.phase : undefined) ?? (mode === "never" ? "starting" : "installing");
  // A failed run puts the focus on Retry.
  useEffect(() => void (state.error && retry.current?.focus()), [state.error]);
  const btn = "max-md:h-11 max-md:w-full";
  const check = state.check;
  const action = check ? actionOf(check, !!failed) : undefined;
  const fix = check && check.verdict !== "running" ? fixText(check, label) : undefined;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 py-4 text-center text-sm max-md:px-4 *:first:mt-auto *:last:mb-auto"
      role="status"
      aria-live="polite"
      aria-busy={inProgress || !!state.checking}
      data-testid="side-status"
    >
      {error && !inProgress && (
        <>
          <p className="max-h-[min(12rem,40dvh)] w-full max-w-md shrink-0 select-text overflow-y-auto text-destructive [overflow-wrap:anywhere]" role="alert" data-testid="side-error">
            {error}
          </p>
          <Button size="sm" onClick={() => onRun(failed ?? "needed")} className={`shrink-0 ${btn}`} ref={retry} data-testid="side-retry">
            Retry
          </Button>
        </>
      )}
      {inProgress ? (
        <>
          <p className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground" data-testid="side-progress">
            <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {PHASE_TEXT[phase]}
            <Elapsed />
          </p>
          <Button size="sm" disabled aria-busy="true" className={`shrink-0 ${btn}`} data-testid="side-install">
            {mode === "never" ? "Starting…" : "Installing…"}
          </Button>
        </>
      ) : (
        <>
          {state.checking && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
              Checking {label}…
            </p>
          )}
          {state.legacy && <p className="max-w-md text-muted-foreground">Can't check this side on this daemon version. You can still install it.</p>}
          {state.checkError && (
            <p className="max-h-[min(8rem,30dvh)] w-full max-w-md shrink-0 select-text overflow-y-auto text-destructive [overflow-wrap:anywhere]" role="alert">
              Could not check {label}: {state.checkError}
            </p>
          )}
          {check && !state.checking && (
            <div className="flex w-full max-w-md shrink-0 flex-col gap-2 text-left" data-testid="side-check">
              <ul className="flex flex-col gap-1">
                {rowsOf(check).map((r) => (
                  <li key={r.name} className="flex flex-wrap items-baseline gap-x-2 [overflow-wrap:anywhere]" data-testid="side-check-row" data-status={r.status}>
                    {r.status === "ok" ? <CheckIcon className="size-4 shrink-0 self-center text-success" aria-hidden /> : r.status === "missing" ? <TriangleAlertIcon className="size-4 shrink-0 self-center text-destructive" aria-hidden /> : <MinusIcon className="size-4 shrink-0 self-center text-faint" aria-hidden />}
                    <span className="font-medium">{r.name}</span>
                    <span className="text-muted-foreground">{r.value}</span>
                  </li>
                ))}
              </ul>
              <p className="font-medium">{VERDICT_TEXT[check.verdict]}</p>
              {fix && <p className="select-text text-muted-foreground [overflow-wrap:anywhere]">{fix}</p>}
            </div>
          )}
          <div className="flex w-full max-w-md shrink-0 flex-wrap justify-center gap-2 max-md:flex-col">
            {!state.legacy && (
              <Button size="sm" variant="outline" disabled={state.checking} onClick={onCheck} className={btn} data-testid="side-check-again">
                Check again
              </Button>
            )}
            {action && !state.checking && (
              <Button size="sm" onClick={() => onRun(action.mode)} className={btn} data-testid="side-install">
                {action.label}
              </Button>
            )}
            {state.legacy && (
              <Button size="sm" onClick={() => onRun("plain")} className={btn} data-testid="side-install">
                Install
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
