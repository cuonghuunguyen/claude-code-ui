// A second `opencode serve` on the daemon's OpenCode data dir: creates a session "from outside", as the OpenCode CLI or app would. No Playwright import.
import { spawn, type ChildProcess } from "node:child_process";
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
export async function createOpenCodeSession(bin: string, run: string, cwd: string, title: string, text: string): Promise<string> {
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
    const sent = await fetch(`${base}/session/${id}/prompt_async${q}`, { method: "POST", headers: json, body: JSON.stringify({ noReply: true, parts: [{ type: "text", text }] }) });
    if (!sent.ok) throw new Error(`prompt_async answered ${sent.status}`);
    // prompt_async answers 204 at once; the message is stored a moment later.
    for (let i = 0; i < 50; i++) {
      const list = (await (await fetch(`${base}/session/${id}/message${q}`)).json()) as unknown[];
      if (list.length) return id;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("the user message was not stored");
  } finally {
    await killTreeAsync(child.pid!);
  }
}
