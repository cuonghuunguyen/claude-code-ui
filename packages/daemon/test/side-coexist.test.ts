// An SSH Side Daemon shares its machine with a normal claude-ui Hub (own daemon on a TCP port, ~/.config/claude-ui with daemon.json, token,
// settings, versions/). The real `--side` Daemon process runs through attach, a pipe takeover and a Grace exit; everything of the Hub stays
// byte for byte (content and mtime), its port keeps answering, its process is not signalled.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
let hubPort: Server | undefined;
afterEach(() => {
  hubPort?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every file under `root`: path, size, mtime, content hash (symlinks not followed). */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) (out.push(`${p}/ ${st.mtimeMs}`), walk(p));
      else out.push(`${p} ${st.size} ${st.mtimeMs} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(root);
  return out;
}

/** A remote that already runs its own Hub: config folder filled, a process (this one) listening on its port. */
async function remoteWithHub() {
  const home = realpathSync(mkdtempSync(join("/tmp", "cx-")) /* short: a socket path holds 103 bytes on macOS */);
  dirs.push(home);
  const cfg = join(home, ".config/claude-ui");
  mkdirSync(join(cfg, "versions/9.9.9"), { recursive: true });
  hubPort = createServer((c) => c.end("hub")).listen(0, "127.0.0.1");
  await new Promise((r) => hubPort!.once("listening", r));
  const port = (hubPort.address() as { port: number }).port;
  writeFileSync(join(cfg, "daemon.json"), JSON.stringify({ port, pid: process.pid, version: "9.9.9", startedAt: "2026-01-01T00:00:00Z" }));
  for (const f of ["token", "sessions.json", "settings.json", "projects.json", "secrets.json", "side-lists.json", "side-attached.json", "side-grace.json"]) writeFileSync(join(cfg, f), `${f}\n`);
  writeFileSync(join(cfg, "versions/9.9.9/marker"), "hub build");
  // The Hub's own side install root sits beside ours.
  mkdirSync(join(home, ".local/share/claude-ui/versions/9.9.9"), { recursive: true });
  writeFileSync(join(home, ".local/share/claude-ui/versions/9.9.9/marker"), "hub build");
  return { home, cfg, port };
}

const tcpAnswers = (port: number) => new Promise<boolean>((ok) => connect(port, "127.0.0.1").once("data", () => ok(true)).once("error", () => ok(false)));

describe.skipIf(process.platform === "win32")("an SSH Side Daemon on a remote that runs its own claude-ui Hub", () => {
  it("attach, takeover and Grace exit leave the Hub's config folder, versions/, port and process untouched; the Daemon keeps its state in its own folder", async () => {
    const { home, cfg, port } = await remoteWithHub();
    const sockDir = join(home, ".local/share/claude-ui/side");
    mkdirSync(sockDir, { recursive: true, mode: 0o700 });
    const sock = join(sockDir, ".side.sock");
    const before = snapshot(join(home, ".config")).concat(snapshot(join(home, ".local/share/claude-ui/versions")));
    const child = spawn(process.execPath, ["--import", "tsx", main, "--side"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: "", CLAUDE_UI_SIDE_LISTEN: sock, CLAUDE_UI_SIDE_SOCK: sock }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => (err += b));
    const exited = new Promise<number | null>((ok) => child.on("exit", ok));
    try {
      for (let i = 0; i < 300 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(sock), err).toBe(true);
      // Two Hubs attach one after the other (a takeover); the second ends the pipe at once with a 1 ms Grace period.
      const lines: string[] = [];
      const attach = () => connect(sock).on("data", (b) => lines.push(String(b)));
      const first = attach();
      await new Promise((r) => setTimeout(r, 500));
      const second = attach();
      second.write('{"grace":1}\n');
      await new Promise((r) => setTimeout(r, 500));
      expect(lines.join("")).toContain('"taken":1');
      expect(await tcpAnswers(port)).toBe(true);
      second.end();
      first.destroy();
      expect(await exited).toBe(0); // the idle Daemon expired
      expect(existsSync(sock)).toBe(false);
      expect(existsSync(join(sockDir, ".data"))).toBe(true); // its own state
    } finally {
      child.kill("SIGKILL");
    }
    expect(snapshot(join(home, ".config")).concat(snapshot(join(home, ".local/share/claude-ui/versions")))).toEqual(before);
    expect(await tcpAnswers(port)).toBe(true);
    expect(() => process.kill(process.pid, 0)).not.toThrow(); // the Hub's pid is ours: still alive
    expect(cfg).toContain(".config/claude-ui");
  }, 60_000);
});
