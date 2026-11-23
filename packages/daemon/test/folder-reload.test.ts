import { describe, expect, it } from "vitest";
import { createFolderReloads } from "../src/folder-reload.ts";

describe("pending folder reloads", () => {
  it("one reload of an engine that reloads every location tells the dialogs of all waiting folders", async () => {
    let busy = true;
    const calls: string[][] = [];
    const told: string[] = [];
    const r = createFolderReloads({ all: true, reload: async (_c, folders) => (calls.push(folders), !busy), changed: (k, cwd) => told.push(`${k}@${cwd}`), retryMs: 10_000 });
    expect(await r.request("/a", ["skills"])).toBe(false);
    expect(await r.request("/b", ["plugins"])).toBe(false);
    busy = false;
    calls.length = 0;
    r.settled();
    await new Promise((res) => setTimeout(res, 50));
    expect(calls).toHaveLength(1);
    expect(told.sort()).toEqual(["plugins@/b", "skills@/a"]);
    expect(r.pending("/a") || r.pending("/b")).toBe(false);
    r.close();
  });

  it("a request of a folder whose retry is running reloads after it and keeps both the change and the retry's mark", async () => {
    const order: string[] = [];
    let release!: () => void;
    let n = 0;
    const r = createFolderReloads({
      reload: async () => {
        const i = ++n;
        order.push(`start${i}`);
        if (i === 2) await new Promise<void>((res) => (release = res));
        order.push(`end${i}`);
        return i !== 1;
      },
      changed: () => {},
      retryMs: 10_000,
    });
    expect(await r.request("/a", ["mcp"])).toBe(false); // busy: pending
    r.settled(); // the retry starts (second reload) and waits
    await new Promise((res) => setTimeout(res, 20));
    const second = r.request("/a", ["skills"]);
    await new Promise((res) => setTimeout(res, 20));
    expect(order).toEqual(["start1", "end1", "start2"]); // the request waits for the retry
    release();
    expect(await second).toBe(true);
    expect(order.slice(3)).toEqual(["end2", "start3", "end3"]);
    r.close();
  });
});
