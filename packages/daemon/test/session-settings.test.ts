import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSessionSettings, PRUNE_GRACE_MS } from "../src/session-settings.ts";

const posix = process.platform !== "win32";
const file = () => join(mkdtempSync(join(tmpdir(), "cfg-")), "sessions.json");

describe("session settings (sessions.json)", () => {
  it("two daemons on one file: changes of different sessions are both kept (GH-91)", () => {
    const f = file();
    const a = createSessionSettings({ file: f });
    const b = createSessionSettings({ file: f });
    a.set("s1", { model: "haiku" });
    b.set("s2", { permissionMode: "plan" });
    const fresh = createSessionSettings({ file: f });
    expect(fresh.get("s1")).toMatchObject({ model: "haiku" });
    expect(fresh.get("s2")).toMatchObject({ permissionMode: "plan" });
    expect(a.get("s2")).toMatchObject({ permissionMode: "plan" });
  });

  it("an orchestration link before the first query: the query start still saves all settings, and the link stays (GH-79)", () => {
    const s = createSessionSettings({ file: file() });
    s.set("w", { coordinatorId: "c", name: "a", cwd: "/r", port: 1 });
    s.set("w", { model: "default", permissionMode: "acceptEdits", effort: "default" }, []);
    expect(s.get("w")).toMatchObject({ coordinatorId: "c", name: "a", cwd: "/r", port: 1, permissionMode: "acceptEdits" });
    // A link after the settings: only its fields change.
    s.set("x", { model: "haiku", permissionMode: "plan", effort: "high" });
    s.set("x", { coordinatorId: "w", name: "b" });
    expect(s.get("x")).toMatchObject({ model: "haiku", permissionMode: "plan", effort: "high", coordinatorId: "w", name: "b" });
    expect(s.entries().map(([id]) => id)).toEqual(["w", "x"]);
  });

  it("two daemons change different fields of one session: both fields are kept (GH-91)", () => {
    const f = file();
    const a = createSessionSettings({ file: f });
    const b = createSessionSettings({ file: f });
    a.set("s1", { model: "haiku", permissionMode: "default", effort: "default" });
    b.set("s1", { effort: "high" });
    a.set("s1", { model: "opus" });
    expect(createSessionSettings({ file: f }).get("s1")).toMatchObject({ model: "opus", permissionMode: "default", effort: "high" });
  });

  it("set of some fields writes all given settings when the latest file has no entry (deleted by another daemon) (GH-91)", () => {
    const f = file();
    const a = createSessionSettings({ file: f });
    const all = { model: "haiku", permissionMode: "plan", effort: "high" } as const;
    a.set("s1", all, ["effort"]);
    expect(a.get("s1")).toMatchObject(all);
    createSessionSettings({ file: f }).delete(["s1"]);
    a.set("s1", all, ["model"]);
    expect(createSessionSettings({ file: f }).get("s1")).toMatchObject(all);
    a.set("s1", { ...all, model: "opus", effort: "low" }, ["model"]);
    expect(a.get("s1")).toMatchObject({ ...all, model: "opus" });
  });

  it("a corrupt file is logged once and counts as empty (GH-91)", () => {
    const f = file();
    writeFileSync(f, '{"s1":');
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = createSessionSettings({ file: f });
      expect(s.ids()).toEqual([]);
      expect(s.ids()).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0][0])).toContain("session settings");
    } finally {
      log.mockRestore();
    }
  });

  it("delete and the entry cap apply to the latest file; least recently changed go first", () => {
    const f = file();
    const a = createSessionSettings({ file: f, max: 2 });
    const b = createSessionSettings({ file: f, max: 2 });
    a.set("s1", { effort: "low" });
    b.set("s2", { effort: "low" });
    a.set("s1", { effort: "high" });
    b.set("s3", { effort: "low" });
    expect(createSessionSettings({ file: f }).ids()).toEqual(["s1", "s3"]);
    a.delete(["s1"]);
    expect(b.ids()).toEqual(["s3"]);
  });

  it("prune keeps a transcript-less entry another daemon saved within the grace period; older ones go (GH-91)", () => {
    const f = file();
    let t = 0;
    const a = createSessionSettings({ file: f, now: () => t });
    const b = createSessionSettings({ file: f, now: () => t });
    a.set("old", { effort: "low" });
    t = PRUNE_GRACE_MS;
    // A new session live on daemon A, no transcript yet.
    a.set("new", { effort: "high" });
    a.set("kept", { effort: "high" });
    t = PRUNE_GRACE_MS + 1;
    b.prune((id) => id === "kept");
    expect(createSessionSettings({ file: f }).ids()).toEqual(["new", "kept"]);
    // An entry without a save time (written before GH-91) counts as old.
    writeFileSync(f, '{"x":{"effort":"low"}}');
    b.prune(() => false);
    expect(b.ids()).toEqual([]);
  });

  it("a truncated or wrong-shaped file counts as empty; a save leaves no temp file", () => {
    const f = file();
    writeFileSync(f, '{"s1":{"model":"haiku"');
    const s = createSessionSettings({ file: f });
    expect(s.ids()).toEqual([]);
    writeFileSync(f, "[1]");
    expect(s.ids()).toEqual([]);
    s.set("s2", { model: "haiku" });
    expect(readdirSync(join(f, ".."))).toEqual(["sessions.json"]);
  });

  it.skipIf(!posix || process.getuid?.() === 0)("a failed save keeps the change in memory for the run (GH-91)", () => {
    const f = file();
    const dir = join(f, "..");
    writeFileSync(f, '{"old":{"model":"haiku"}}');
    const s = createSessionSettings({ file: f });
    chmodSync(dir, 0o500);
    try {
      expect(() => s.set("new", { effort: "high" })).toThrow();
      expect(s.get("new")).toMatchObject({ effort: "high" });
      expect(s.ids()).toEqual(["old", "new"]);
      expect(readdirSync(dir)).toEqual(["sessions.json"]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("an unreadable file (a directory) keeps the settings in memory instead of throwing (GH-91)", () => {
    const f = file();
    const s = createSessionSettings({ file: f });
    s.set("s1", { model: "haiku" });
    rmSync(f);
    mkdirSync(f);
    expect(s.get("s1")).toMatchObject({ model: "haiku" });
    expect(s.ids()).toEqual(["s1"]);
  });
});
