// `npm run e2e:stop -- <run-dir>`: ends a run by PID, never by name. No Playwright import: vitest tests the pure parts.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { killTree } from "./daemon.ts";

const norm = (s: string) => s.split(String.fromCharCode(92)).join("/").toLowerCase();

/** True when a process command line mentions the run folder, in any slash style or case. */
export function commandLineMentions(commandLine: string, run: string): boolean {
  return norm(commandLine).includes(norm(resolve(run)).replace(/\/+$/, "") + "/");
}

/** The PID in a *.pid file, or 0. */
export function readPid(file: string): number {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** Command line of a live process, or "" when none runs under that PID. */
export function commandLineOf(pid: number, platform: NodeJS.Platform = process.platform): string {
  const res =
    platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8", windowsHide: true })
      : spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return res.status === 0 ? res.stdout.trim() : "";
}

/** Kills the runner by `<run>/runner.pid`, then every live `daemon-w*.pid` daemon whose command line holds the run folder. Returns what it did. */
export function stopRun(run: string, kill: (pid: number) => void = killTree, cmdline: (pid: number) => string = commandLineOf): string[] {
  const done: string[] = [];
  if (!existsSync(run)) throw new Error(`no such run folder: ${run}`);
  const runner = readPid(join(run, "runner.pid"));
  // A kept runner.pid can outlive its runner and Windows reuses PIDs: kill only a live Playwright runner.
  if (runner && /playwright/i.test(cmdline(runner))) {
    kill(runner);
    done.push(`runner ${runner}: tree killed`);
  } else if (runner) done.push(`runner ${runner}: not a running Playwright runner, left alone`);
  else done.push("no runner.pid: runner not killed");
  rmSync(join(run, "runner.pid"), { force: true });
  for (const name of readdirSync(run).filter((n) => /^daemon-w\d+\.pid$/.test(n))) {
    const pid = readPid(join(run, name));
    if (pid && commandLineMentions(cmdline(pid), run)) {
      kill(pid);
      done.push(`daemon ${pid} (${name}): tree killed`);
    } else if (pid) done.push(`daemon ${pid} (${name}): not running or not of this run, left alone`);
    rmSync(join(run, name), { force: true });
  }
  return done;
}
