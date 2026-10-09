// The panel of a WSL distro or Docker container that is not ready (Open project): the read-only check result, the one action
// (Install, Update, Reinstall, Install anyway) and the progress or the failure of that action. It never starts anything by
// itself: the owner calls onRun when a button is pressed (docs/spec.md "Sides").
import { useEffect, useRef, useState } from "react";
import { CheckIcon, LoaderCircleIcon, MinusIcon, TriangleAlertIcon } from "lucide-react";
import type { SideCheck, SideInfo, SidePhase, SideSetup } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";

/** What a button asks `side.start` for: a setup mode, or "plain" (a hub without side.check: no setup field). */
export type RunMode = SideSetup | "plain";

/** What the dialog knows about one side's panel. */
export type PanelState = {
  checking?: boolean;
  check?: SideCheck;
  /** The hub is older than this page: it cannot check (unknown_type, or side_not_ready from its old router). */
  legacy?: boolean;
  /** The check itself failed (timeout, disconnect). */
  checkError?: string;
  /** A `side.start` from this dialog is running. */
  busy?: { mode: RunMode };
  /** The last start from this dialog failed: its message and the mode that failed (Retry sends the same one). */
  error?: string;
  failed?: RunMode;
};

const PHASE_TEXT: Record<SidePhase, string> = {
  packing: "Packing claude-ui…",
  copying: "Copying into the container…",
  installing: "Installing (npm, can take minutes)…",
  starting: "Starting…",
};

const verdictText = (v: SideCheck["verdict"], label: string): string =>
  ({
    running: "Running.",
    starting: "Starting…",
    installed: "claude-ui is installed here.",
    install: "claude-ui is not installed here yet.",
    update: "An older claude-ui is installed. Update it to match this one.",
    blocked: `${label} can't be set up yet.`,
  })[v];

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

/**
 * The one main button for a check result, or none (blocked, running, or installed: that one starts by itself). `failed`: a start
 * from this dialog failed. Reinstall only for a side the check finds installed after such a failure (the install may be broken);
 * a side error alone never makes it the main button.
 */
export function actionOf(check: SideCheck, failed: boolean): { label: string; mode: SideSetup } | undefined {
  const v = check.verdict;
  if (check.reason === "not_logged_in" && (v === "blocked" || v === "install" || v === "update")) return { label: "Install anyway", mode: "needed" };
  if (v === "install") return { label: "Install", mode: "needed" };
  if (v === "update") return { label: "Update", mode: "needed" };
  if (v === "installed" && failed) return { label: "Reinstall", mode: "force" };
  return undefined;
}

function Elapsed() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setS((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  // Hidden from screen readers: a tick every second would be read out again and again.
  return (
    <span data-testid="side-elapsed" aria-hidden="true">
      {s} s
    </span>
  );
}

export function SidePanel({
  side,
  state,
  onRun,
  onCheck,
}: {
  side: SideInfo;
  state: PanelState;
  onRun: (mode: RunMode) => void;
  onCheck: () => void;
}) {
  const { label } = side;
  const retry = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const error = state.error ?? (side.state === "error" ? (side.message ?? `${label} is not running.`) : undefined);
  // Retry sends the mode that failed. An error the dialog did not cause (a stopped container) only starts what is installed.
  const failed = state.failed;
  const inProgress = !!state.busy || side.state === "starting";
  const mode = state.busy?.mode ?? "needed";
  const phase = side.phase ?? (state.check?.verdict === "starting" ? state.check.phase : undefined) ?? (mode === "never" ? "starting" : "installing");
  // A failed run puts the focus on Retry.
  useEffect(() => void (state.error && retry.current?.focus()), [state.error]);
  // The button that started a run goes away (a disabled button loses the focus): the region keeps it, unless it is elsewhere in the dialog.
  useEffect(() => {
    const a = document.activeElement;
    if (inProgress && (!a || a === document.body || a.getAttribute("role") === "dialog" || region.current?.contains(a))) region.current?.focus();
  }, [inProgress]);
  // An older hub: Check again goes away for the plain Install view, so the focus would fall to the body.
  useEffect(() => {
    const a = document.activeElement;
    if (state.legacy && (!a || a === document.body)) region.current?.focus();
  }, [state.legacy]);
  const btn = "max-md:h-11 max-md:w-full";
  const check = state.check;
  const action = check ? actionOf(check, failed !== undefined) : undefined;
  const fix = check && check.verdict !== "running" ? fixText(check, label) : undefined;
  return (
    <div
      ref={region}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 py-4 text-center text-sm outline-none max-md:px-4 *:first:mt-auto *:last:mb-auto"
      aria-busy={inProgress || !!state.checking}
      data-testid="side-status"
    >
      {error && !inProgress && (
        <>
          <p className="max-h-[min(12rem,40dvh)] w-full max-w-md shrink-0 select-text overflow-y-auto whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]" role="alert" data-testid="side-error">
            {error}
          </p>
          <Button size="sm" onClick={() => onRun(failed ?? "never")} className={`shrink-0 ${btn}`} ref={retry} data-testid="side-retry">
            Retry
          </Button>
        </>
      )}
      {state.checkError && !inProgress && (
        <p className="max-h-[min(8rem,30dvh)] w-full max-w-md shrink-0 select-text overflow-y-auto whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]" role="alert">
          Could not check {label}: {state.checkError}
        </p>
      )}
      {/* What is happening (checking, progress, an older hub). Errors are alerts of their own, outside this region. */}
      <div role="status" aria-live="polite" className="flex w-full max-w-md shrink-0 flex-col items-center gap-3 empty:hidden" data-testid="side-live">
        {inProgress ? (
          <p className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground" data-testid="side-progress">
            <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {PHASE_TEXT[phase]}
            <Elapsed />
          </p>
        ) : (
          <>
            {state.checking && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                Checking {label}…
              </p>
            )}
            {state.legacy && <p className="text-muted-foreground">This version of Claude UI can't check {label}. You can still install it.</p>}
          </>
        )}
      </div>
      {inProgress ? (
        <Button size="sm" disabled aria-busy="true" className={`shrink-0 ${btn}`} data-testid="side-install">
          {mode === "never" ? "Starting…" : "Installing…"}
        </Button>
      ) : (
        <>
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
              <div role="status" aria-live="polite" className="flex flex-col gap-2">
                <p className="font-medium">{verdictText(check.verdict, label)}</p>
                {fix && <p className="select-text text-muted-foreground [overflow-wrap:anywhere]">{fix}</p>}
              </div>
            </div>
          )}
          <div className="flex w-full max-w-md shrink-0 flex-wrap justify-center gap-2 max-md:flex-col">
            {!state.legacy && (
              // aria-disabled, not disabled: a disabled button loses the keyboard focus, and Check again keeps it while it checks.
              <Button size="sm" variant="outline" aria-disabled={state.checking || undefined} onClick={() => !state.checking && onCheck()} className={`${btn} aria-disabled:opacity-50`} data-testid="side-check-again">
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
