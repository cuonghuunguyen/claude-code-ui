import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionInfo, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_TAIL_BYTES, lastEntryTime, listSessionsOffThread, mapLimit, patchScan, scanThreadConfig, transcriptStamp } from "../src/session-scan.ts";

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

  it("scans on the main thread from then on when the SDK cannot be imported in the thread", async () => {
    config();
    const realUrl = scanThreadConfig.sdkUrl;
    scanThreadConfig.sdkUrl = "file:///no/such/sdk.mjs";
    try {
      expect(await listSessionsOffThread()).toEqual(await listSessions());
      expect(scanThreadConfig.broken).toBe(true);
      scanThreadConfig.sdkUrl = realUrl;
      expect(await listSessionsOffThread()).toHaveLength(1);
      expect(scanThreadConfig.broken).toBe(true);
    } finally {
      scanThreadConfig.sdkUrl = realUrl;
    }
  });

  it("drops a thread that does not answer in time, answers on the main thread and starts a new thread next", async () => {
    config();
    const realTimeout = scanThreadConfig.timeoutMs;
    scanThreadConfig.timeoutMs = 200;
    scanThreadConfig.script = `require("node:worker_threads").parentPort.on("message", () => {});`;
    try {
      expect(await listSessionsOffThread()).toEqual(await listSessions());
      expect(scanThreadConfig.broken).toBe(false);
      scanThreadConfig.script = realScript;
      scanThreadConfig.timeoutMs = realTimeout;
      expect(await listSessionsOffThread()).toHaveLength(1);
      expect(scanThreadConfig.broken).toBe(false);
    } finally {
      scanThreadConfig.timeoutMs = realTimeout;
    }
  });

  it("server.ts reads the stamp and last-message times async (no sync tail read)", () => {
    const src = readFileSync(join(import.meta.dirname, "../src/server.ts"), "utf8");
    // The last-message read moved with the Claude catalogue.
    const claude = readFileSync(join(import.meta.dirname, "../src/claude-catalogue.ts"), "utf8");
    expect(claude).toMatch(/import \{[^}]*\blastEntryTime\b[^}]*\} from "\.\/session-scan\.ts"/);
    expect(src).toMatch(/import \{[^}]*\btranscriptStamp\b[^}]*\} from "\.\/session-scan\.ts"/);
    expect(src).not.toMatch(/\breadSync\b/);
    expect(claude).not.toMatch(/\breadSync\b/);
    expect(src).not.toMatch(/function transcriptStamp/);
  });

  it("rejects with the SDK's error when listSessions() throws in the thread", async () => {
    scanThreadConfig.reset();
    scanThreadConfig.script = `require("node:worker_threads").parentPort.on("message", ({ id }) => require("node:worker_threads").parentPort.postMessage({ id, error: "bad dir" }));`;
    await expect(listSessionsOffThread()).rejects.toThrow(/bad dir/);
  });

  it("keeps the main event loop free while it scans many transcripts", { timeout: 60_000 }, async () => {
    config(600, 120);
    const h = monitorEventLoopDelay({ resolution: 10 });
    await listSessionsOffThread(); // starts the thread, loads the SDK
    h.enable();
    const sessions = await listSessionsOffThread();
    h.disable();
    expect(sessions).toHaveLength(600);
    // Reverted to a main-thread scan this measured 215 ms with 400 files; the fixture is heavier now.
    expect(h.max / 1e6).toBeLessThan(100);
  });

  it("transcriptStamp changes when a transcript is added, grows or is touched; undefined without the folder", async () => {
    const root = config();
    const dir = join(root, "projects");
    const stamp = async (d: string) => {
      const m = await transcriptStamp(d);
      return m && JSON.stringify([...m]);
    };
    const a = (await stamp(dir))!;
    expect(a).toContain("-tmp-p/");
    const f = join(dir, "-tmp-p", "4b2c3d4e-5f60-4718-8a9b-000000000000.jsonl");
    writeFileSync(f, "{}\n{}\n");
    const b = await stamp(dir);
    expect(b).not.toBe(a);
    const t = statSync(f).mtimeMs / 1000 + 10;
    utimesSync(f, t, t);
    const c = await stamp(dir);
    expect(c).not.toBe(b);
    writeFileSync(join(dir, "-tmp-p", "5b2c3d4e-5f60-4718-8a9b-000000000000.jsonl"), "{}\n");
    expect(await stamp(dir)).not.toBe(c);
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

  describe("patchScan", () => {
    const id = (n: number) => `4b2c3d4e-5f60-4718-8a9b-${String(n).padStart(12, "0")}`;
    const path = (root: string, n: number | string, folder = "-tmp-p") => join(root, "projects", folder, typeof n === "number" ? `${id(n)}.jsonl` : n);
    const at = (f: string, sec: number) => utimesSync(f, sec, sec);
    const base = async (root: string) => ({ stamp: (await transcriptStamp(join(root, "projects")))!, result: await listSessions() });
    const patch = async (root: string, last: Awaited<ReturnType<typeof base>>) =>
      patchScan(last, (await transcriptStamp(join(root, "projects")))!, join(root, "projects"), (s) => getSessionInfo(s));

    it("gives the same list as a full listSessions() after transcripts are added, changed and removed", async () => {
      const root = config(3);
      for (let i = 0; i < 3; i++) at(path(root, i), 1_700_000_000 + i * 10);
      const last = await base(root);
      writeFileSync(path(root, 10), entry("user", "2026-02-01T00:00:00.000Z", " new") + "\n");
      at(path(root, 10), 1_700_000_100);
      writeFileSync(path(root, 11), "");
      writeFileSync(path(root, 12), JSON.stringify({ type: "user", isSidechain: true, cwd: "/tmp/p", sessionId: "s", timestamp: "2026-02-01T00:00:00.000Z", message: { role: "user", content: "side" } }) + "\n");
      writeFileSync(path(root, "not-a-uuid.jsonl"), entry("user", "2026-02-01T00:00:00.000Z") + "\n");
      writeFileSync(path(root, 1), entry("user", "2026-01-01T00:00:00.000Z") + "\n" + entry("assistant", "2026-01-01T00:00:05.000Z") + "\n");
      at(path(root, 1), 1_700_000_200);
      rmSync(path(root, 2));
      const got = await patch(root, last);
      expect(got).toEqual(await listSessions());
      const ids = got!.map((s) => s.sessionId);
      expect(ids).toContain(id(10));
      expect(ids).not.toContain(id(2));
      expect(ids).not.toContain(id(11));
      expect(ids).not.toContain(id(12));
    });

    it("leaves a duplicate session id and a continued-in transcript to the full scan", async () => {
      const root = config(1);
      const last = await base(root);
      mkdirSync(join(root, "projects", "-tmp-q"));
      writeFileSync(path(root, 0, "-tmp-q"), entry("user", "2026-02-01T00:00:00.000Z") + "\n");
      expect(await patch(root, last)).toBeUndefined();
      // The duplicate stays, one copy is removed.
      const dup = await base(root);
      rmSync(path(root, 0, "-tmp-q"));
      expect(await patch(root, dup)).toBeUndefined();

      const root2 = config(1);
      const last2 = await base(root2);
      const A = id(20);
      const B = id(21);
      writeFileSync(path(root2, 20), entry("user", "2026-02-01T00:00:00.000Z") + "\n" + JSON.stringify({ type: "continued-in", continuedInSessionId: B }) + "\n");
      writeFileSync(path(root2, 21), JSON.stringify({ ...JSON.parse(entry("user", "2026-02-02T00:00:00.000Z")), parentUuid: null }) + "\n");
      expect(await patch(root2, last2)).toBeUndefined();
      expect((await listSessions()).map((s) => s.sessionId)).not.toContain(A);
    });
  });
});
