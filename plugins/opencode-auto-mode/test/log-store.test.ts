import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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
    const { decisions } = readLog(dir);
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
  it("returns nothing for a missing dir, skips malformed lines, and the last label per request wins", () => {
    expect(readLog(join(tmp(), "none"))).toEqual({ decisions: [], labels: new Map() });
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
    const { decisions, labels } = readLog(dir);
    expect(decisions).toHaveLength(1);
    expect(labels.get("per1")?.reply).toBe("once");
  });
});
