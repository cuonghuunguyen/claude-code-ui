// The panel of a WSL distro or Docker container that is not ready (Open project): the read-only check result, the one action
// (Install, Update, Reinstall) and the progress or the failure of that action. It never starts anything by
// itself: the owner calls onRun when a button is pressed (docs/spec.md "Sides").
import { useEffect, useRef, useState } from "react";
import { CheckIcon, LoaderCircleIcon, MinusIcon, TriangleAlertIcon } from "lucide-react";
import { NODE_MIN, NODE_MIN_MAJOR, type SideCheck, type SideInfo, type SidePhase, type SideSetup } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { t, useT } from "./i18n.ts";
import { ContainerNeeds } from "./container-needs.tsx";

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

const phaseText = (p: SidePhase) => t(`app.sidePanel.phase.${p}`);

const verdictText = (v: SideCheck["verdict"], label: string): string => t(`app.sidePanel.verdict.${v}`, { side: label });

/** The fix per reason, used when the daemon sent no message. */
function fixText(check: SideCheck, label: string): string | undefined {
  if (check.message) return check.message;
  const f = check.facts;
  const v = { side: label, min: NODE_MIN, major: NODE_MIN_MAJOR };
  switch (check.reason) {
    case "gone":
      return t("app.sidePanel.fix.gone", v);
    case "not_running":
      return t("app.sidePanel.fix.notRunning", v);
    case "unreachable":
      return t("app.sidePanel.fix.unreachable", v);
    case "no_build":
      return t("app.sidePanel.fix.noBuild");
    case "package_unreadable":
      return t("app.sidePanel.fix.packageUnreadable");
    case "node_missing":
      return t("app.sidePanel.fix.nodeMissing", v);
    case "node_old":
      return t("app.sidePanel.fix.nodeOld", { ...v, node: f.node ?? "" });
    case "build_tools_missing":
      return t("app.sidePanel.fix.buildToolsMissing", { ...v, tools: missingTools(f.buildTools).join(", ") });
    case "unpack_tools_missing":
      return t("app.sidePanel.fix.unpackToolsMissing", v);
    case "no_writable_path":
      return t("app.sidePanel.fix.noWritablePath", v);
    case "check_failed":
      return t("app.sidePanel.fix.checkFailed");
    default:
      return undefined;
  }
}

const missingTools = (tools?: { make: boolean; python3: boolean; cxx: boolean }) => (tools ? ([!tools.make && "make", !tools.python3 && "python3", !tools.cxx && "g++"].filter(Boolean) as string[]) : []);

type Row = { name: string; value: string; status: "ok" | "missing" | "na" };
function rowsOf(c: SideCheck, docker = true): Row[] {
  const f = c.facts;
  const na = (name: string): Row => ({ name, value: t("app.sidePanel.row.notChecked"), status: "na" });
  const reachable = t("app.sidePanel.row.reachable");
  const node = t("app.sidePanel.row.nodeName", { major: NODE_MIN_MAJOR });
  const buildTools = t("app.sidePanel.row.buildToolsName");
  const forBuild = t("app.sidePanel.row.forBuild");
  if (!f.reachable) return [{ name: reachable, value: t("app.sidePanel.row.no"), status: "missing" }, na(node), na(buildTools), na(forBuild)];
  const tools = missingTools(f.buildTools);
  const build: Row = f.installed === "current" ? { name: forBuild, value: t("app.sidePanel.row.installed"), status: "ok" } : f.installed === "other" ? { name: forBuild, value: t("app.sidePanel.row.olderInstalled"), status: "missing" } : { name: forBuild, value: t("app.sidePanel.row.notInstalled"), status: "missing" };
  const up: Row = { name: reachable, value: t(f.running ? "app.sidePanel.row.yesRunning" : "app.sidePanel.row.yes"), status: "ok" };
  // Docker with the bundle (or a build that runs on its own Node.js): the container's Node.js and build tools do not matter.
  if ((f.install?.method === "bundle" && f.installed !== "current") || (f.installed === "current" && f.bundled)) {
    const tg = f.target;
    const target = tg ? `${tg.arch}, ${tg.libc}${tg.glibc ? ` ${tg.glibc}` : ""}` : "Linux";
    return [up, { name: t(docker ? "app.sidePanel.row.container" : "app.sidePanel.row.distro"), value: f.install?.method === "bundle" ? t(f.install.parts === "download" ? "app.sidePanel.row.bundleDownload" : "app.sidePanel.row.bundle", { target }) : target, status: "ok" }, build];
  }
  return [
    up,
    f.node === undefined && f.nodeOk === undefined ? na(node) : f.node && f.nodeOk ? { name: node, value: f.node, status: "ok" } : { name: node, value: f.node ? t("app.sidePanel.row.tooOld", { node: f.node }) : t("app.sidePanel.row.notInstalled"), status: "missing" },
    !f.buildTools ? na(buildTools) : tools.length ? { name: buildTools, value: t("app.sidePanel.row.missing", { tools: tools.join(", ") }), status: "missing" } : { name: buildTools, value: t("app.sidePanel.row.found"), status: "ok" },
    build,
  ];
}

/**
 * The one main button for a check result, or none (blocked, running, or installed: that one starts by itself). `failed`: a start
 * from this dialog failed. Reinstall only for a side the check finds installed after such a failure (the install may be broken);
 * a side error alone never makes it the main button.
 */
export function actionOf(check: SideCheck, failed: boolean): { label: string; mode: SideSetup } | undefined {
  const v = check.verdict;
  if (v === "install") return { label: t("app.sidePanel.action.install"), mode: "needed" };
  if (v === "update") return { label: t("app.sidePanel.action.update"), mode: "needed" };
  if (v === "installed" && failed) return { label: t("app.sidePanel.action.reinstall"), mode: "force" };
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
  const t = useT();
  const { label } = side;
  const retry = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const error = state.error ?? (side.state === "error" ? (side.message ?? t("app.sidePanel.notRunning", { side: label })) : undefined);
  // Retry sends the mode that failed. An error the dialog did not cause (a stopped container) only starts what is installed.
  const failed = state.failed;
  const inProgress = !!state.busy || side.state === "starting";
  const mode = state.busy?.mode ?? "needed";
  const phase = side.phase ?? (state.check?.verdict === "starting" ? state.check.phase : undefined) ?? (mode === "never" ? "starting" : "installing");
  const docker = side.id.startsWith("docker:");
  const noun = t(docker ? "app.sidePanel.noun.container" : "app.sidePanel.noun.distro");
  // Installing from the bundle only unpacks; npm (WSL, or a Docker fallback) can take minutes.
  // An install first looks at the container or distro (which install, which parts): no phase yet.
  const progressText = !side.phase && mode !== "never" && state.check?.verdict !== "starting" ? t("app.sidePanel.preparing") : phase === "installing" && side.bundle ? t("app.sidePanel.unpacking", { noun }) : phaseText(phase);
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
            {t("app.sidePanel.retry")}
          </Button>
        </>
      )}
      {state.checkError && !inProgress && (
        <p className="max-h-[min(8rem,30dvh)] w-full max-w-md shrink-0 select-text overflow-y-auto whitespace-pre-wrap text-destructive [overflow-wrap:anywhere]" role="alert">
          {t("app.sidePanel.couldNotCheck", { side: label, error: state.checkError })}
        </p>
      )}
      {/* What is happening (checking, progress, an older hub). Errors are alerts of their own, outside this region. */}
      <div role="status" aria-live="polite" className="flex w-full max-w-md shrink-0 flex-col items-center gap-3 empty:hidden" data-testid="side-live">
        {inProgress ? (
          <p className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground" data-testid="side-progress">
            <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
            {progressText}
            <Elapsed />
          </p>
        ) : null}
        {inProgress && side.nodeNote ? (
          <p className="text-muted-foreground [overflow-wrap:anywhere]" data-testid="side-node-note">
            {t("app.sidePanel.nodeNote", { noun, note: side.nodeNote })}
          </p>
        ) : null}
        {inProgress && side.fallback ? (
          <p className="text-muted-foreground [overflow-wrap:anywhere]" data-testid="side-fallback">
            {t("app.sidePanel.fallback", { noun, reason: side.fallback })}
          </p>
        ) : null}
        {!inProgress && (
          <>
            {state.checking && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                {t("app.sidePanel.checking", { side: label })}
              </p>
            )}
            {state.legacy && <p className="text-muted-foreground">{t("app.sidePanel.legacy", { side: label })}</p>}
          </>
        )}
      </div>
      {inProgress ? (
        <Button size="sm" disabled aria-busy="true" className={`shrink-0 ${btn}`} data-testid="side-install">
          {mode === "never" ? t("app.sidePanel.starting") : t("app.sidePanel.installing")}
        </Button>
      ) : (
        <>
          {check && !state.checking && (
            <div className="flex w-full max-w-md shrink-0 flex-col gap-2 text-left" data-testid="side-check">
              <ul className="flex flex-col gap-1">
                {rowsOf(check, docker).map((r) => (
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
                {check.facts.install?.method === "npm" && check.verdict !== "installed" && check.verdict !== "running" && !fix?.includes("installs with npm") && (
                  <p className="select-text text-muted-foreground [overflow-wrap:anywhere]" data-testid="side-check-npm">
                    {check.facts.install.reason ? t("app.sidePanel.npmInstallReason", { noun, reason: check.facts.install.reason }) : t("app.sidePanel.npmInstall", { noun })}
                  </p>
                )}
              </div>
            </div>
          )}
          <div className="flex w-full max-w-md shrink-0 flex-wrap justify-center gap-2 max-md:flex-col">
            {!state.legacy && (
              // aria-disabled, not disabled: a disabled button loses the keyboard focus, and Check again keeps it while it checks.
              <Button size="sm" variant="outline" aria-disabled={state.checking || undefined} onClick={() => !state.checking && onCheck()} className={`${btn} aria-disabled:opacity-50`} data-testid="side-check-again">
                {t("app.sidePanel.checkAgain")}
              </Button>
            )}
            {action && !state.checking && (
              <Button size="sm" onClick={() => onRun(action.mode)} className={btn} data-testid="side-install">
                {action.label}
              </Button>
            )}
            {state.legacy && (
              <Button size="sm" onClick={() => onRun("plain")} className={btn} data-testid="side-install">
                {t("app.sidePanel.install")}
              </Button>
            )}
          </div>
          {docker && <ContainerNeeds check={state.checking ? undefined : check} />}
        </>
      )}
    </div>
  );
}
