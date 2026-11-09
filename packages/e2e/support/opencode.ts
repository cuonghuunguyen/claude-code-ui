// A second `opencode serve` on the daemon's OpenCode data dir: creates a session "from outside", as the OpenCode CLI or app would. No Playwright import.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { cacheHome, configHome } from "./paths.ts";
import { killTreeAsync } from "./daemon.ts";

/** OpenCode's own store of the run: keeps test sessions out of ~/.local/share/opencode. */
export const opencodeEnv = (run: string): NodeJS.ProcessEnv => ({
  XDG_DATA_HOME: join(run, "opencode-data"),
  XDG_STATE_HOME: join(run, "opencode-state"),
  XDG_CACHE_HOME: cacheHome(run),
  XDG_CONFIG_HOME: configHome(run),
});

/** Creates a session titled `title` in `cwd` with one user message that needs no model (`noReply`), then stops the helper server (by PID). */
export async function createOpenCodeSession(bin: string, run: string, cwd: string, title: string, text: string | string[]): Promise<string> {
  const texts = Array.isArray(text) ? text : [text];
  const child: ChildProcess = spawn(bin, ["serve", "--port", "0", "--hostname", "127.0.0.1"], { cwd, env: { ...process.env, ...opencodeEnv(run) }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  try {
    const base = await new Promise<string>((res, rej) => {
      let out = "";
      const t = setTimeout(() => rej(new Error(`opencode serve printed no URL:\n${out}`)), 30_000);
      const on = (d: Buffer) => {
        out += String(d);
        const m = out.match(/listening on (http:\/\/\S+)/);
        if (m) (clearTimeout(t), res(m[1]!));
      };
      child.stdout!.on("data", on);
      child.stderr!.on("data", on);
      child.once("exit", (c) => rej(new Error(`opencode serve exited (${c}):\n${out}`)));
    });
    const q = `?directory=${encodeURIComponent(cwd)}`;
    const json = { "content-type": "application/json" };
    const made = await fetch(`${base}/session${q}`, { method: "POST", headers: json, body: JSON.stringify({ title }) });
    if (!made.ok) throw new Error(`POST /session answered ${made.status}`);
    const { id } = (await made.json()) as { id: string };
    // prompt_async answers 204 at once and the message is stored a moment later: one by one, so the order holds.
    for (const [n, t] of texts.entries()) {
      const sent = await fetch(`${base}/session/${id}/prompt_async${q}`, { method: "POST", headers: json, body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: t }] }) });
      if (!sent.ok) throw new Error(`prompt_async answered ${sent.status}`);
      let stored = false;
      for (let i = 0; i < 50 && !stored; i++) {
        stored = ((await (await fetch(`${base}/session/${id}/message${q}`)).json()) as unknown[]).length > n;
        if (!stored) await new Promise((r) => setTimeout(r, 200));
      }
      if (!stored) throw new Error("the user message was not stored");
    }
    return id;
  } finally {
    await killTreeAsync(child.pid!);
  }
}

/** The OpenCode server the daemon `daemonPid` started (POSIX): the descendant that listens on a port and holds the server password. Found through `ps` and `lsof`, so the test asks the same server the app uses. */
export function daemonOpenCodeServer(daemonPid: number): { url: string; auth: string } {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const todo = [daemonPid];
  for (let i = 0; i < todo.length; i++) for (const [pid, ppid] of rows) if (ppid === todo[i] && !todo.includes(pid!)) todo.push(pid!);
  for (const pid of todo.slice(1)) {
    const env = execFileSync("ps", ["eww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    const password = /OPENCODE_SERVER_PASSWORD=(\S+)/.exec(env)?.[1];
    if (!password) continue;
    let listen = "";
    try {
      listen = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
    } catch {}
    const port = /^n[^\n]*:(\d+)$/m.exec(listen)?.[1];
    if (port) return { url: `http://127.0.0.1:${port}`, auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  }
  throw new Error("the daemon has no OpenCode server yet");
}
