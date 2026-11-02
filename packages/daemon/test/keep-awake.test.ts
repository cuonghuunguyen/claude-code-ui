import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeepAwake, inhibitorFor } from "../src/keep-awake.ts";

const inh = { cmd: "/usr/bin/inh", args: ["a"] };
function fake() {
  const children: (EventEmitter & { stdin: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>; unref: () => void })[] = [];
  const spawn = vi.fn((..._a: unknown[]) => {
    const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: () => {} });
    children.push(c);
    return c;
  });
  return { spawn: spawn as never, calls: spawn, children };
}
afterEach(() => vi.restoreAllMocks());

describe("inhibitorFor", () => {
  it("macOS runs caffeinate -i -w with the daemon pid", () => {
    expect(inhibitorFor("darwin", 123, "", () => true)).toEqual({ cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "123"] });
  });
  it("Linux runs systemd-inhibit from PATH with cat on the daemon's pipe", () => {
    const seen: string[] = [];
    const exists = (p: unknown) => (seen.push(String(p)), p === "/usr/bin/systemd-inhibit");
    expect(inhibitorFor("linux", 1, "bin:/usr/bin:/opt", exists)).toEqual({ cmd: "/usr/bin/systemd-inhibit", args: ["--what=idle:sleep", "--who=claude-ui", "--why=Session running", "cat"] });
    expect(seen).not.toContain("bin/systemd-inhibit");
  });
  it("Linux without systemd-inhibit and Windows are unsupported", () => {
    expect(inhibitorFor("linux", 1, "/usr/bin", () => false)).toBeUndefined();
    expect(inhibitorFor("win32", 1, "", () => true)).toBeUndefined();
  });
});

describe("createKeepAwake", () => {
  it("update(true) twice spawns one process on a stdin pipe", () => {
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    k.update(true);
    k.update(true);
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect((f.calls.mock.calls[0]![2] as { stdio: unknown[] }).stdio[0]).toBe("pipe");
  });
  it("update(false) kills it; update(true) spawns again", () => {
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    k.update(true);
    k.update(false);
    k.update(true);
    expect(f.children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(f.calls).toHaveBeenCalledTimes(2);
  });
  it("close() kills the held process and is safe with none", () => {
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    k.close();
    k.update(true);
    k.close();
    expect(f.children[0]!.kill).toHaveBeenCalledTimes(1);
  });
  it("unsupported: update(true) spawns nothing; status supported false", () => {
    const f = fake();
    const k = createKeepAwake({ spawn: f.spawn });
    k.update(true);
    expect(f.calls).not.toHaveBeenCalled();
    expect(k.status()).toEqual({ supported: false });
  });
  it("spawn error keeps the error, notifies once, logs once and does not retry", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    const l = vi.fn();
    k.onStatus(l);
    k.update(true);
    f.children[0]!.emit("error", new Error("spawn inh ENOENT"));
    expect(k.status().error).toContain("ENOENT");
    expect(l).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    k.update(true);
    k.update(false);
    k.update(true);
    expect(f.calls).toHaveBeenCalledTimes(1);
  });
  it("unexpected exit with stderr reports its last line", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    k.update(true);
    f.children[0]!.stderr.write("noise\nFailed to inhibit: Access denied\n");
    f.children[0]!.emit("exit", 1, null);
    expect(k.status().error?.endsWith("Access denied")).toBe(true);
  });
  it("own kill is no error", () => {
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    const l = vi.fn();
    k.onStatus(l);
    k.update(true);
    k.update(false);
    f.children[0]!.emit("exit", null, "SIGTERM");
    expect(k.status().error).toBeUndefined();
    expect(l).not.toHaveBeenCalled();
  });
  it("reset() lets the next update spawn again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake();
    const k = createKeepAwake({ inhibitor: inh, spawn: f.spawn });
    k.update(true);
    f.children[0]!.emit("error", new Error("x"));
    k.reset();
    k.update(true);
    expect(f.calls).toHaveBeenCalledTimes(2);
    expect(k.status().error).toBeUndefined();
  });
});
