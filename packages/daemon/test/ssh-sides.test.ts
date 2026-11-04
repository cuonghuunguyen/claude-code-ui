import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { sshError } from "../src/ssh-side.ts";
import { sideTarget } from "../src/side-kinds.ts";
import { createSides, wslSide, type SavedSide, type SideProcess } from "../src/sides.ts";

/** A side process that answers `ready` at once, or exits with `code` after writing `stderr`. */
function proc(o: { ready?: boolean; code?: number; stderr?: string } = {}): SideProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = new EventEmitter();
  setTimeout(() => {
    if (o.ready !== false) stdout.write('{"ready":true}\n');
    else (stderr.write(o.stderr ?? ""), setTimeout(() => exit.emit("exit", o.code ?? 255), 5));
  }, 5);
  return { stdin: new PassThrough(), stdout, stderr, kill: () => exit.emit("exit", 0), on: (e, l) => exit.on(e, l) };
}

function registry(spawn: () => SideProcess, saved: SavedSide[] = []) {
  const saves: SavedSide[][] = [];
  const sides = createSides({ targets: [sideTarget("ssh", "box"), wslSide("Ubuntu")], spawn, save: (x) => saves.push(x), saved, exitMessage: (id, code, err) => (id === "ssh:box" ? sshError("box", { code, stderr: err }) : undefined) });
  return { sides, saves };
}
const row = (s: ReturnType<typeof createSides>, id: string) => s.list().find((x) => x.id === id)!;

describe("SSH Side in the registry", () => {
  it("is listed off as SSH: <alias>; once ready it is not saved: Start with Claude UI is off by default", async () => {
    const { sides, saves } = registry(() => proc());
    expect(row(sides, "ssh:box")).toEqual({ id: "ssh:box", label: "SSH: box", state: "off" });
    await sides.start("ssh:box");
    expect(row(sides, "ssh:box")).toMatchObject({ state: "ready" });
    expect(row(sides, "ssh:box").autoStart).toBeUndefined();
    expect(saves).toEqual([]);
    sides.close();
  });

  it("Start with Claude UI on: saved, and the next Hub start starts it by itself; off again forgets it", async () => {
    const { sides, saves } = registry(() => proc());
    expect(sides.prefs("ssh:box", { start: true })).toBe(true);
    expect(saves.at(-1)).toEqual([{ id: "ssh:box" }]);
    sides.close();
    const next = registry(() => proc(), [{ id: "ssh:box" }]);
    await vi_waitFor(() => row(next.sides, "ssh:box").state === "ready");
    expect(row(next.sides, "ssh:box").autoStart).toBe(true);
    next.sides.prefs("ssh:box", { start: false });
    expect(next.saves.at(-1)).toEqual([]);
    next.sides.close();
  });

  it("a WSL Side that is ready is still saved (unchanged)", async () => {
    const { sides, saves } = registry(() => proc());
    await sides.start("wsl:Ubuntu");
    expect(saves.at(-1)?.map((x) => x.id)).toEqual(["wsl:Ubuntu"]);
    sides.close();
  });

  it("ssh ending with 255 before ready ends in error with the next step; host key and unreachable too", async () => {
    for (const [stderr, text] of [["box: Permission denied (publickey).", "Run `ssh box` once in a terminal"], ["Host key verification failed.", "Run `ssh box` once in a terminal"], ["ssh: connect to host box port 22: Connection refused", "is not reachable"]] as const) {
      const { sides } = registry(() => proc({ ready: false, stderr }));
      await expect(sides.start("ssh:box")).rejects.toThrow(text);
      expect(row(sides, "ssh:box")).toMatchObject({ state: "error" });
      expect(row(sides, "ssh:box").message).toContain(text);
      sides.close();
    }
  });
});

async function vi_waitFor(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}
