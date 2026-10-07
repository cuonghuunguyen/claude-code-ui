import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parseProcessTable, watchChain, wrapperChain } from "../src/ancestors.ts";

const table = parseProcessTable(["10 9 node.exe\r", "9 8 node.exe", "8 7 bash.exe", "7 6 bash.exe", "6 5 node.exe", "5 4 pwsh.exe", "4 0 Windows Terminal.exe", "bad line", "20 0 x.exe"].join("\n"));

describe("ancestors", () => {
  it("parseProcessTable reads pid, ppid and names with spaces and CRLF", () => {
    expect(table.get(10)).toEqual({ ppid: 9, name: "node.exe" });
    expect(table.get(4)).toEqual({ ppid: 0, name: "Windows Terminal.exe" });
    expect(table.size).toBe(8);
  });
  it("wrapperChain walks node/bash/cmd ancestors and stops at the user shell", () => {
    expect(wrapperChain(table, 10).map((a) => a.pid)).toEqual([9, 8, 7, 6]);
  });
  it("wrapperChain stops on a missing parent, pid 0 and a cycle", () => {
    expect(wrapperChain(table, 99)).toEqual([]);
    expect(wrapperChain(table, 20)).toEqual([]);
    const cyc = parseProcessTable("1 2 node.exe\n2 3 node.exe\n3 1 node.exe");
    expect(wrapperChain(cyc, 1).map((a) => a.pid)).toEqual([2, 3]);
  });
  const chain = [{ pid: 1, name: "node.exe" }, { pid: 2, name: "bash.exe" }];
  const fake = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    const gone = vi.fn(), log = vi.fn();
    watchChain(chain, gone, { log, spawn: () => child as never });
    return { child, gone, log };
  };
  it("watchChain: an empty chain is not watched", () => expect(watchChain([], () => {})).toBeUndefined());
  it("watchChain calls onGone once for a GONE line of a chain pid, also split over chunks", () => {
    const { child, gone } = fake();
    child.stdout.emit("data", "GONE");
    child.stdout.emit("data", " 2\r\nGONE 1\n");
    expect(gone).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledWith({ pid: 2, name: "bash.exe" });
  });
  it("watchChain never calls onGone for a failed, empty or partial watcher", () => {
    for (const act of [
      (c: ReturnType<typeof fake>) => c.child.emit("error", new Error("spawn powershell.exe ENOENT")),
      (c: ReturnType<typeof fake>) => c.child.emit("exit", 1),
      (c: ReturnType<typeof fake>) => (c.child.stdout.emit("data", "GONE 99\nGONE 2"), c.child.emit("exit", 0)),
      (c: ReturnType<typeof fake>) => (c.child.stdout.emit("data", "Exception: boom\n"), c.child.emit("exit", 1)),
    ]) {
      const c = fake();
      act(c);
      expect(c.gone).not.toHaveBeenCalled();
      expect(c.log).toHaveBeenCalled();
    }
  });
  it("watchChain logs a SKIP line (a pid the watcher cannot open) and keeps watching", () => {
    const { child, gone, log } = fake();
    child.stdout.emit("data", "SKIP 1 Access is denied\n");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skips pid 1 Access is denied"));
    expect(gone).not.toHaveBeenCalled();
    child.stdout.emit("data", "GONE 2\n");
    expect(gone).toHaveBeenCalledTimes(1);
  });
  it("watchChain only logs when the watcher cannot be spawned", () => {
    const gone = vi.fn(), log = vi.fn();
    expect(watchChain(chain, gone, { log, spawn: () => { throw new Error("EACCES"); } })).toBeUndefined();
    expect(gone).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
  });
});
