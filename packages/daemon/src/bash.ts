// Bash mode (`!` in the prompt box): one shell command in the session cwd, like the terminal panel's shell, without a pty.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { win32 } from "node:path";
import { shell, shellEnv } from "./terminals.ts";

export const MAX_BASH_OUTPUT_CHARS = 30_000; // CLI Bash tool default
export const BASH_TIMEOUT_MS = 600_000; // CLI Bash tool max
export const BASH_KILL_GRACE_MS = 2_000;
/** After the shell exited, a background process holding the pipes may still send output; this long, then the pipes are closed. */
export const BASH_DRAIN_MS = 500;
export type BashResult = { stdout: string; stderr: string; exitCode?: number; stopped: boolean };
export type BashRun = { done: Promise<BashResult>; kill(): void };

/** argv for `shell -c command`: POSIX `-c`; pwsh/powershell `-NoProfile -Command`; cmd `/d /s /c`. */
export function shellArgs(shellPath: string, command: string): string[] {
  const exe = win32.basename(shellPath.replace(/\//g, "\\")).toLowerCase().replace(/\.exe$/, "");
  if (exe === "pwsh" || exe === "powershell") return ["-NoProfile", "-Command", command];
  if (exe === "cmd") return ["/d", "/s", "/c", command];
  return ["-c", command];
}

/** Runs `command` like the terminal panel's shell would (shell(), shellEnv()), stdin closed; each output stream capped. */
export function runBash(
  command: string,
  cwd: string,
  onOutput: (stdout: string, stderr: string) => void,
  opts: { timeoutMs?: number; maxChars?: number } = {},
): BashRun {
  const max = opts.maxChars ?? MAX_BASH_OUTPUT_CHARS;
  const sh = shell();
  const win = process.platform === "win32";
  const child = spawn(sh, shellArgs(sh, command), { cwd, env: shellEnv(), stdio: ["ignore", "pipe", "pipe"], detached: !win, windowsHide: true });
  const text = { out: "", err: "" };
  const cut = { out: false, err: false };
  let stopped = false;
  let closed = false;
  let note = "";
  const feed = (key: "out" | "err") => (chunk: string) => {
    const room = max - text[key].length;
    if (chunk.length > room) cut[key] = true;
    if (room <= 0) return;
    let part = chunk.slice(0, room);
    // Not in the middle of a surrogate pair.
    if (part.length < chunk.length && /[\ud800-\udbff]$/.test(part)) part = part.slice(0, -1);
    text[key] += part;
    onOutput(text.out, text.err);
  };
  child.stdout.setEncoding("utf8").on("data", feed("out"));
  child.stderr.setEncoding("utf8").on("data", feed("err"));
  const kill = () => {
    stopped = true;
    note ||= "Stopped by user";
    if (closed || child.pid === undefined) return;
    try {
      if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else {
        process.kill(-child.pid, "SIGTERM");
        // Always: the shell may be gone while a child that ignores TERM lives on in the group (ESRCH when none is left).
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group gone */ }
        }, BASH_KILL_GRACE_MS).unref();
      }
    } catch { /* ESRCH: already gone */ }
  };
  const timer = setTimeout(() => {
    note = `Timed out after ${Math.round((opts.timeoutMs ?? BASH_TIMEOUT_MS) / 1000)} s`;
    kill();
  }, opts.timeoutMs ?? BASH_TIMEOUT_MS).unref();
  const done = new Promise<BashResult>((resolve) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (closed) return;
      clearTimeout(timer);
      closed = true;
      const mark = (k: "out" | "err") => text[k] + (cut[k] ? `\n… output truncated at ${max} characters` : "");
      if (spawnError) return resolve({ stdout: "", stderr: spawnError.message, exitCode: 127, stopped: false });
      // A signal ends the shell without a code: 128 + signal number, as a shell reports it.
      const exitCode = code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : undefined);
      resolve({ stdout: mark("out"), stderr: [mark("err"), note].filter(Boolean).join("\n"), ...(exitCode === undefined ? {} : { exitCode }), stopped });
    };
    child.on("error", (e) => finish(null, null, e));
    // `exit`, not `close`: a background process (setsid) can hold the pipes open for good, and Stop must still release the session.
    child.on("exit", (code, signal) => {
      const t = setTimeout(() => (child.stdout.destroy(), child.stderr.destroy(), finish(code, signal)), BASH_DRAIN_MS);
      child.once("close", () => (clearTimeout(t), finish(code, signal)));
    });
  });
  return { done, kill };
}
