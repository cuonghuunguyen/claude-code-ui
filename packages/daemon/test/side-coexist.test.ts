// ADR 0009: a real Hub started by an attach (CLAUDE_UI_STARTED_BY=attach) accepts a Hub on its attach socket, says ready (schema, startedBy), and
// exits after its Grace period once the Hub is gone. daemon.json is written while it runs and removed at exit.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const main = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => void dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe.skipIf(process.platform === "win32")("a Hub started by an attach", () => {
  it("accepts a Hub on its attach socket, then exits after Grace and removes daemon.json and the socket", async () => {
    const home = realpathSync(mkdtempSync(join("/tmp", "cx-"))); // short: a socket path holds 103 bytes on macOS
    dirs.push(home);
    const cfg = join(home, "cfg");
    const sock = join(home, "a.sock");
    const child = spawn(process.execPath, ["--import", "tsx", main, "--no-open", "--port", "0"], { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: cfg, CLAUDE_UI_CONFIG_DIR: join(cfg, "claude-ui"), CLAUDE_UI_ATTACH_SOCK: sock, CLAUDE_UI_STARTED_BY: "attach" }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (b) => (err += b));
    const exited = new Promise<number | null>((ok) => child.on("exit", ok));
    try {
      for (let i = 0; i < 300 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(sock), err).toBe(true);
      const lines: string[] = [];
      const s = connect(sock).on("data", (b) => lines.push(String(b)));
      s.write('{"hello":{"schema":[1,1]}}\n{"grace":1}\n');
      for (let i = 0; i < 50 && !lines.join("").includes("ready"); i++) await new Promise((r) => setTimeout(r, 100));
      expect(lines.join("")).toMatch(/"ready":true.*"schema":\[1,1\].*"startedBy":"attach"/);
      s.end();
      expect(await exited).toBe(0);
      expect(existsSync(sock)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 60_000);
});
