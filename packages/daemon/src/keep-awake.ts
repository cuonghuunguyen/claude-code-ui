// Keep computer awake (GH-523, docs/spec.md "Keep computer awake"): one OS sleep inhibitor child, held while wanted.
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";

export type Inhibitor = { cmd: string; args: string[] };
export type KeepAwake = ReturnType<typeof createKeepAwake>;

/** macOS: `caffeinate -w` ends with the daemon; Linux: `cat` on our stdin pipe ends with the daemon (no orphan, even on SIGKILL). */
export function inhibitorFor(platform: NodeJS.Platform, pid: number, path = process.env.PATH ?? "", exists = existsSync): Inhibitor | undefined {
  if (platform === "darwin") return exists("/usr/bin/caffeinate") ? { cmd: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] } : undefined;
  if (platform !== "linux") return undefined;
  const dir = path.split(delimiter).find((d) => isAbsolute(d) && exists(join(d, "systemd-inhibit")));
  return dir ? { cmd: join(dir, "systemd-inhibit"), args: ["--what=idle:sleep", "--who=claude-ui", "--why=Session running", "cat"] } : undefined;
}

export function createKeepAwake(o: { inhibitor?: Inhibitor; spawn?: typeof nodeSpawn }) {
  const spawn = o.spawn ?? nodeSpawn;
  let child: ChildProcess | undefined;
  let error: string | undefined;
  const listeners = new Set<() => void>();
  const fail = (msg: string) => {
    child = undefined;
    error = `${basename(o.inhibitor!.cmd)}: ${msg}`;
    console.error(`keep awake: ${error}`);
    listeners.forEach((l) => l());
  };
  const stop = () => {
    const c = child;
    child = undefined;
    c?.kill();
  };
  return {
    status: () => ({ supported: !!o.inhibitor, ...(error && { error }) }),
    update(want: boolean) {
      if (!want) return stop();
      if (child || error || !o.inhibitor) return;
      // The stdin pipe stays open: its end (daemon death) is what stops the Linux inhibitor.
      const c = (child = spawn(o.inhibitor.cmd, o.inhibitor.args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true }));
      let last = "";
      c.stderr?.on("data", (d) => (last = String(d).trim().split("\n").at(-1) ?? last));
      c.on("error", (e) => child === c && fail(e.message));
      // Our own kill clears `child` first, so only an unexpected exit reaches fail.
      c.on("exit", (code, sig) => child === c && fail(last || `exited with ${code ?? sig}`));
      c.unref();
      (c.stdin as { unref?: () => void } | null)?.unref?.();
      (c.stderr as { unref?: () => void } | null)?.unref?.();
    },
    /** The setting went off: the next on may try again. */
    reset: () => void (error = undefined),
    close: stop,
    onStatus(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
