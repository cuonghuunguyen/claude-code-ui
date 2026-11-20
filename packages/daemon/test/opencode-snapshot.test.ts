// Local history of OpenCode's edits (docs/spec.md "Local history", ADR 0010): a `patch` part of a step -> the content before the step, from a real
// snapshot git dir laid out as OpenCode 1.19.5 does (<data>/snapshot/<projectID>/<sha1 of the worktree>). Risk: the history misses or corrupts agent edits.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { createOpenCodeServer } from "../src/opencode-server.ts";
import { createOpenCodeEngine } from "../src/opencode-engine.ts";
import type { Session, SessionOpts } from "../src/session.ts";
import type { OpenCodeServer } from "../src/opencode-server.ts";

type Payload = { type: string; properties: Record<string, any> };
let root: string;
let worktree: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "oc-snap-")));
  worktree = join(root, "wt");
  mkdirSync(worktree);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

/** A snapshot store holding `files` (the tree before a step); returns the tree hash. */
function snapshot(files: Record<string, string>, data = join(root, "data")) {
  const dir = join(data, "snapshot", "proj1", createHash("sha1").update(worktree).digest("hex"));
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", ["--git-dir", dir, "--work-tree", worktree, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(worktree, f), c);
  git("add", "-A");
  return git("write-tree");
}

function rig(data: string = join(root, "data")) {
  const handlers = new Set<{ event: (d: string | undefined, p: Payload) => void; resync: () => void }>();
  const server = {
    request: vi.fn(async (path: string) => (path === "/path" ? { worktree } : path.startsWith("/session/") ? { id: "ses_p", projectID: "proj1" } : undefined)),
    dataDir: async () => data,
    events: (h: never) => (handlers.add(h), () => handlers.delete(h)),
    streamReady: async () => {},
  } as unknown as OpenCodeServer;
  const edits: [string, string][] = [];
  const session = { id: "ses_p", cwd: worktree, emit: () => {}, currentState: () => "running", setState: () => {}, request: () => {}, pendingRequest: () => undefined, cancel: () => {} } as unknown as Session;
  const run = createOpenCodeEngine(server).open(session, { permissionMode: "default", onFileEdit: (p: string, o: string) => edits.push([p, o]) } as SessionOpts);
  run.begin();
  const patch = (hash: string, files: string[], id = "prt_1", sessionID = "ses_p") => handlers.forEach((h) => h.event("/p", { type: "message.part.updated", properties: { part: { id, type: "patch", sessionID, messageID: "msg_1", hash, files } } }));
  return { edits, patch };
}

describe("OpenCode edits in Local history", () => {
  it("keeps the content before the step of each changed file that the snapshot holds", async () => {
    const hash = snapshot({ "a.txt": "before\n", "..dots": "dots-before", "big.txt": "x".repeat(300 * 1024) });
    writeFileSync(join(worktree, "a.txt"), "after\n");
    const r = rig();
    // a new file and a file over the 256 KB limit give no entry; a file outside the worktree neither.
    r.patch(hash, [join(worktree, "new.txt"), join(worktree, "big.txt"), join(root, "outside.txt"), join(worktree, "a.txt"), join(worktree, "..dots")]);
    await vi.waitFor(() => expect(r.edits).toEqual([[join(worktree, "a.txt"), "before\n"], [join(worktree, "..dots"), "dots-before"]]));
  });

  it("reads a patch part once however often OpenCode repeats the part event", async () => {
    const hash = snapshot({ "a.txt": "before\n" });
    const r = rig();
    r.patch(hash, [join(worktree, "a.txt")]);
    r.patch(hash, [join(worktree, "a.txt")]);
    await vi.waitFor(() => expect(r.edits).toHaveLength(1));
    await new Promise((res) => setTimeout(res, 100));
    expect(r.edits).toHaveLength(1);
  });

  it("gives no entry and no error, with one log line, when the snapshot store is missing", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = rig(join(root, "no-such-data"));
    r.patch("a".repeat(40), [join(worktree, "a.txt")]);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(String(log.mock.calls[0]![0])).toContain("snapshot store");
    expect(r.edits).toEqual([]);
  });
});

describe("OpenCode data folder", () => {
  const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
  it("is the data line of `debug paths`, run with the server's environment; undefined when the binary prints none", async () => {
    const withData = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN], env: () => ({ FAKE_OPENCODE_DATA_DIR: "/some/data dir" }) });
    expect(await withData.dataDir()).toBe("/some/data dir");
    const without = createOpenCodeServer({ path: () => "", command: [process.execPath, BIN] });
    expect(await without.dataDir()).toBeUndefined();
    // A failed run is not kept: the next call asks again (a busy machine must not turn the feature off for good).
    const cmd = [join(root, "no-such-binary")];
    const later = createOpenCodeServer({ path: () => "", command: cmd, env: () => ({ FAKE_OPENCODE_DATA_DIR: "/late/data" }) });
    expect(await later.dataDir()).toBeUndefined();
    cmd.splice(0, 1, process.execPath, BIN);
    expect(await later.dataDir()).toBe("/late/data");
  });
});
