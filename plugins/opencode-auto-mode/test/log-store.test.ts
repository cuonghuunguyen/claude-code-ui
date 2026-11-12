import { mkdtempSync, utimesSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decision } from "./fixtures.ts";
import { createLogStore, resolveDataDir, readLog, hashPolicy } from "../log-store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "auto-mode-log-"));

describe("resolveDataDir", () => {
  it("prefers the logDir option", () => {
    expect(resolveDataDir("/custom", { XDG_DATA_HOME: "/x" }, "/home/u")).toBe("/custom");
  });
  it("then $XDG_DATA_HOME/opencode", () => {
    expect(resolveDataDir(undefined, { XDG_DATA_HOME: "/x" }, "/home/u").replace(/\\/g, "/")).toBe("/x/opencode");
  });
  it("then ~/.local/share/opencode (what OpenCode itself uses on every OS)", () => {
    expect(resolveDataDir(undefined, {}, "/home/u").replace(/\\/g, "/")).toBe("/home/u/.local/share/opencode");
  });
});

describe("hashPolicy", () => {
  it("is a stable short hex hash", () => {
    expect(hashPolicy("a")).toMatch(/^[0-9a-f]{12}$/);
    expect(hashPolicy("a")).toBe(hashPolicy("a"));
    expect(hashPolicy("a")).not.toBe(hashPolicy("b"));
  });
});

describe("createLogStore", () => {
  it("creates <dir>/auto-mode/decisions.jsonl recursively and appends one JSON record per line", async () => {
    const dir = join(tmp(), "deep", "er");
    const store = createLogStore({ dir, maxBytes: 1_000_000, onError: () => {} });
    await store.append(decision());
    await store.append({ v: 1, kind: "label", at: "t", requestID: "per1", reply: "once" });
    const file = join(dir, "auto-mode", "decisions.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(decision());
    expect(lines[1].kind).toBe("label");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates to decisions.1.jsonl past maxBytes, replacing the old rotated file", async () => {
    const dir = tmp();
    const store = createLogStore({ dir, maxBytes: 1500, onError: () => {} });
    const base = join(dir, "auto-mode");
    for (let i = 0; i < 12; i++) await store.append(decision({ requestID: `r${i}` }));
    expect(existsSync(join(base, "decisions.1.jsonl"))).toBe(true);
    expect(existsSync(join(base, "decisions.2.jsonl"))).toBe(false);
    expect(statSync(join(base, "decisions.jsonl")).size).toBeLessThanOrEqual(1500);
    const { decisions } = await readLog(dir);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.length).toBeLessThan(12); // the oldest generation was replaced
    expect(decisions.at(-1)!.requestID).toBe("r11");
  });

  it("swallows write failures and reports once", async () => {
    const root = tmp();
    const blocker = join(root, "file");
    writeFileSync(blocker, "x"); // a file where the directory must go
    const onError = vi.fn();
    const store = createLogStore({ dir: blocker, maxBytes: 1000, onError });
    await expect(store.append(decision())).resolves.toBeUndefined();
    await expect(store.append(decision())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("readLog", () => {
  it("returns nothing for a missing dir, skips malformed lines, and the last label per request wins", async () => {
    expect(await readLog(join(tmp(), "none"))).toEqual({ decisions: [], labels: new Map() });
    const dir = tmp();
    mkdirSync(join(dir, "auto-mode"));
    writeFileSync(
      join(dir, "auto-mode", "decisions.jsonl"),
      [
        JSON.stringify(decision()),
        "not json",
        JSON.stringify({ v: 1, kind: "label", at: "1", requestID: "per1", reply: "reject" }),
        JSON.stringify({ v: 1, kind: "label", at: "2", requestID: "per1", reply: "once" }),
      ].join("\n") + "\n",
    );
    const { decisions, labels } = await readLog(dir);
    expect(decisions).toHaveLength(1);
    expect(labels.get("per1")?.reply).toBe("once");
  });
});

describe("rotation across processes", () => {
  it("does not rotate while another process holds a fresh lock, and takes over a stale one", async () => {
    const dir = tmp();
    const base = join(dir, "auto-mode");
    mkdirSync(base, { recursive: true });
    const file = join(base, "decisions.jsonl");
    writeFileSync(file, "x".repeat(2000) + "\n");
    const lock = join(base, "decisions.lock");
    writeFileSync(lock, "other");
    const store = createLogStore({ dir, maxBytes: 1500, onError: () => {} });
    await store.append(decision());
    expect(existsSync(join(base, "decisions.1.jsonl"))).toBe(false); // someone else is rotating: just append
    expect(readFileSync(file, "utf8")).toContain('"kind":"decision"');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await store.append(decision({ requestID: "r2" }));
    expect(existsSync(join(base, "decisions.1.jsonl"))).toBe(true);
    expect(existsSync(lock)).toBe(false); // released
  });

  it("two stores sharing one dir keep appending through rotations without errors", async () => {
    const dir = tmp();
    const onError = vi.fn();
    const a = createLogStore({ dir, maxBytes: 1500, onError });
    const b = createLogStore({ dir, maxBytes: 1500, onError });
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).append(decision({ requestID: `r${i}` }))));
    expect(onError).not.toHaveBeenCalled();
    expect((await readLog(dir)).decisions.length).toBeGreaterThan(0);
  });

  it("keeps trying after a failure, reporting again only after an hour", async () => {
    const root = tmp();
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    const onError = vi.fn();
    let now = 1_000_000;
    const store = createLogStore({ dir: blocker, maxBytes: 1000, onError, now: () => now });
    await store.append(decision());
    now += 10 * 60_000;
    await store.append(decision());
    expect(onError).toHaveBeenCalledTimes(1);
    now += 61 * 60_000;
    await store.append(decision());
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("creates the directory with mode 0700", async () => {
    const dir = tmp();
    const store = createLogStore({ dir: join(dir, "d"), maxBytes: 1000, onError: () => {} });
    await store.append(decision());
    expect(statSync(join(dir, "d", "auto-mode")).mode & 0o777).toBe(0o700);
  });
});
