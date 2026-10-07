// The `claude-ui` command (docs/spec.md "Updates"): runs the newest daemon, its own package's or one installed into the versions
// dir by an update, as a child in this terminal. Exit RESTART_CODE: start the newest again; any other exit ends the launcher with it.
// An installed version that fails at start is marked and the next newest runs instead.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { compareVersions, FAILED_MARK, installedVersions, isVersion, RESTART_CODE, versionCli } from "./update.ts";

/** A daemon from the versions dir that exits (not 0, not RESTART_CODE) this soon after its start failed to start. */
export const START_WINDOW_MS = 10_000;

/** The daemon to run: the versions dir's newest when it is newer than the own package's `version` (`version` set), else the own. */
export function newest(own: { cli: string; version: string }, dir: string): { cli: string; version?: string } {
  const v = installedVersions(dir)[0];
  return v && (!isVersion(own.version) || compareVersions(v, own.version) > 0) ? { cli: versionCli(dir, v), version: v } : { cli: own.cli };
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** Resolves the exit code to end with. Signals to the launcher go to the running daemon, which then exits. */
export async function launch(opts: {
  args: string[];
  own: { cli: string; version: string };
  dir: string;
  spawn?: (cli: string, args: string[]) => ChildProcess;
  signals?: Pick<NodeJS.Process, "on" | "off">;
  log?: (line: string) => void;
}): Promise<number> {
  const spawn = opts.spawn ?? ((cli, args) => nodeSpawn(process.execPath, [cli, ...args], { stdio: "inherit", env: { ...process.env, CLAUDE_UI_LAUNCHER: "1" } }));
  const signals = opts.signals ?? process;
  const log = opts.log ?? console.error;
  let child: ChildProcess | undefined;
  let stopped = false;
  /** Versions this run marked as failed to start. */
  const marked: string[] = [];
  const forward = (sig: NodeJS.Signals) => {
    stopped = true;
    child?.kill(sig);
  };
  SIGNALS.forEach((s) => signals.on(s, forward));
  try {
    for (;;) {
      const pick = newest(opts.own, opts.dir);
      const startedAt = Date.now();
      child = spawn(pick.cli, opts.args);
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child!.on("error", (err) => (log(`claude-ui: ${err.message}`), resolve([1, null])));
        child!.on("exit", (c, s) => resolve([c, s]));
      });
      if (stopped) return exitCode(code, signal);
      if (code === RESTART_CODE) continue;
      // 129, 130, 143: the daemon ended on a signal it handled or because its parent ended, not a broken release (a native crash code still counts).
      const failedEarly = code !== null && code !== 0 && !SIGNAL_EXITS.includes(code) && signal === null && Date.now() - startedAt < START_WINDOW_MS;
      if (failedEarly && pick.version) {
        // A broken release: run the previous version; a newer one (or a reinstall, which clears the mark) is tried again.
        try {
          writeFileSync(join(opts.dir, pick.version, FAILED_MARK), `exit ${code}\n`);
          marked.push(pick.version);
          log(`claude-ui: ${pick.version} failed to start (exit ${code}); starting the previous version. Retry it by deleting ${join(opts.dir, pick.version)}.`);
          continue;
        } catch {}
      }
      // The previous version fails too: the cause is not the version (e.g. port in use), so the marks go.
      if (failedEarly) marked.forEach((v) => rmSync(join(opts.dir, v, FAILED_MARK), { force: true }));
      return exitCode(code, signal);
    }
  } finally {
    SIGNALS.forEach((s) => signals.off(s, forward));
  }
}

const SIGNAL_EXITS = [129, 130, 143];
/** The child's code; killed by a signal: 128 + its number, as a shell reports it. */
const exitCode = (code: number | null, signal: NodeJS.Signals | null) => code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1);
