import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_TAIL_BYTES, lastEntryTime, listSessionsOffThread, mapLimit, scanThreadConfig, transcriptStamp } from "../src/session-scan.ts";

const realScript = scanThreadConfig.script;
const realEnv = process.env.CLAUDE_CONFIG_DIR;
const dirs: string[] = [];
afterEach(() => {
  if (realEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = realEnv;
  scanThreadConfig.reset();
  scanThreadConfig.script = realScript;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const entry = (type: string, at: string, extra = "") => JSON.stringify({ type, cwd: "/tmp/p", sessionId: "s", timestamp: at, message: { role: type, content: "hello there" + extra } });
function config(n = 1, filler = 0) {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  dirs.push(root);
  mkdirSync(join(root, "projects", "-tmp-p"), { recursive: true });
  for (let i = 0; i < n; i++) {
    const id = `4b2c3d4e-5f60-4718-8a9b-${String(i).padStart(12, "0")}`;
    const lines = [entry("user", "2026-01-01T00:00:00.000Z")];
    for (let k = 0; k < filler; k++) lines.push(entry("assistant", "2026-01-01T00:00:01.000Z", "x".repeat(1000)));
    writeFileSync(join(root, "projects", "-tmp-p", `${id}.jsonl`), lines.join("\n") + "\n");
  }
  process.env.CLAUDE_CONFIG_DIR = root;
  scanThreadConfig.reset();
  return root;
}
const file = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  dirs.push(root);
  const f = join(root, "t.jsonl");
  writeFileSync(f, text);
  return f;
};

describe("session-scan", () => {
  it("lists the same sessions as the SDK's listSessions(), from a worker thread", async () => {
    config();
    const sessions = await listSessionsOffThread();
    expect(sessions).toEqual(await listSessions());
    expect(sessions).toHaveLength(1);
    expect(scanThreadConfig.broken).toBe(false);
  });

  it("runs the scan in a worker thread", async () => {
    scanThreadConfig.reset();
    scanThreadConfig.script = `require("node:worker_threads").parentPort.on("message", ({ id }) => require("node:worker_threads").parentPort.postMessage({ id, sessions: [{ sessionId: String(require("node:worker_threads").threadId) }] }));`;
    const [s] = await listSessionsOffThread();
    expect(s!.sessionId).not.toBe("0");
  });

  it("scans on the main thread when the thread cannot start or fails", async () => {
    config();
    scanThreadConfig.script = `throw new Error("boom");`;
    expect(await listSessionsOffThread()).toEqual(await listSessions());
    expect(scanThreadConfig.broken).toBe(true);
    expect(await listSessionsOffThread()).toHaveLength(1);
  });

  it("starts a new thread after the thread exited", async () => {
    config();
    scanThreadConfig.script = `require("node:worker_threads").parentPort.on("message", () => process.exit(1));`;
    expect(await listSessionsOffThread()).toEqual(await listSessions());
    expect(scanThreadConfig.broken).toBe(false);
    scanThreadConfig.script = realScript;
    expect(await listSessionsOffThread()).toHaveLength(1);
    expect(scanThreadConfig.broken).toBe(false);
  });

  it("rejects with the SDK's error when listSessions() throws in the thread", async () => {
    scanThreadConfig.reset();
    scanThreadConfig.script = `require("node:worker_threads").parentPort.on("message", ({ id }) => require("node:worker_threads").parentPort.postMessage({ id, error: "bad dir" }));`;
    await expect(listSessionsOffThread()).rejects.toThrow(/bad dir/);
  });

  it("keeps the main event loop free while it scans many transcripts", { timeout: 60_000 }, async () => {
    config(400, 120);
    const h = monitorEventLoopDelay({ resolution: 10 });
    await listSessionsOffThread(); // starts the thread, loads the SDK
    h.enable();
    const sessions = await listSessionsOffThread();
    h.disable();
    expect(sessions).toHaveLength(400);
    expect(h.max / 1e6).toBeLessThan(150);
  });

  it("transcriptStamp changes when a transcript is added, grows or is touched; undefined without the folder", async () => {
    const root = config();
    const dir = join(root, "projects");
    const a = (await transcriptStamp(dir))!;
    expect(a).toContain("-tmp-p/");
    const f = join(dir, "-tmp-p", "4b2c3d4e-5f60-4718-8a9b-000000000000.jsonl");
    writeFileSync(f, "{}\n{}\n");
    const b = await transcriptStamp(dir);
    expect(b).not.toBe(a);
    const t = statSync(f).mtimeMs / 1000 + 10;
    utimesSync(f, t, t);
    const c = await transcriptStamp(dir);
    expect(c).not.toBe(b);
    writeFileSync(join(dir, "-tmp-p", "5b2c3d4e-5f60-4718-8a9b-000000000000.jsonl"), "{}\n");
    expect(await transcriptStamp(dir)).not.toBe(c);
    expect(await transcriptStamp(join(root, "none"))).toBeUndefined();
  });

  it("lastEntryTime finds the last user or assistant entry in the last 32 KB", async () => {
    const f = file(
      [entry("user", "2026-01-01T00:00:00.000Z"), entry("assistant", "2026-01-01T00:05:00.000Z"), '{"type":"last-prompt"}', '{"type":"cost-state"}', entry("attachment", "2026-01-02T00:00:00.000Z")].join("\n") + "\n",
    );
    const r = await lastEntryTime(f, 256 * 1024);
    expect(r?.at).toBe(Date.parse("2026-01-01T00:05:00.000Z"));
    const st = statSync(f);
    expect(r?.version).toBe(`${st.mtimeMs}:${st.size}`);
  });

  it("lastEntryTime reads the full tail only when the last 32 KB hold no entry", async () => {
    const filler = '{"type":"progress","n":1}\n';
    const user = entry("user", "2026-01-01T00:00:00.000Z") + "\n";
    const near = file(user + filler.repeat(Math.ceil((64 * 1024) / filler.length)));
    expect(64 * 1024).toBeGreaterThan(FIRST_TAIL_BYTES);
    expect((await lastEntryTime(near, 256 * 1024))?.at).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
    const far = file(user + filler.repeat(Math.ceil((300 * 1024) / filler.length)));
    expect((await lastEntryTime(far, 256 * 1024))?.at).toBeUndefined();
    expect(await lastEntryTime(join(tmpdir(), "no-such-transcript.jsonl"), 256 * 1024)).toBeUndefined();
  });

  it("mapLimit keeps order and runs at most limit at once", async () => {
    let running = 0;
    let max = 0;
    const out = await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async (i) => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 5 + (i % 3)));
      running--;
      return i * 2;
    });
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(max).toBe(3);
  });
});
