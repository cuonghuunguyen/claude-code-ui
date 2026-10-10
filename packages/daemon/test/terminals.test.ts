import { chmodSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createTerminals, fixSpawnHelper, MAX_PENDING_INPUT_BYTES, nodePtyRoot, PAUSE_BYTES, shell, trimScrollback } from "../src/terminals.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

// POSIX-only assertions (file modes, PTY fds, sh syntax) are skipped on Windows.
const posix = process.platform !== "win32";

describe("terminal scrollback trim", () => {
  it("cuts after a line break, so the replay never starts inside an escape sequence", () => {
    const buf = "old\x1b[38;5;208mcolored\nnext\x1b[0m line\n";
    // A plain cut 6 chars in would start at "8;5;208m…", a broken sequence.
    expect(buf.slice(6).startsWith("8;5;208m")).toBe(true);
    expect(trimScrollback(buf, buf.length - 6)).toBe("next\x1b[0m line\n");
  });

  it("without a line break, cuts before the next ESC; short buffers stay whole", () => {
    expect(trimScrollback("ab\x1b[2Jcd\x1b[Hef", 8)).toBe("\x1b[Hef");
    expect(trimScrollback("abc", 8)).toBe("abc");
  });
});

describe("terminal shell", () => {
  const found = (...paths: string[]) => (p: string) => paths.includes(p);

  it("is SHELL when set, else bash outside Windows", () => {
    expect(shell({ SHELL: "/bin/zsh" }, "linux")).toBe("/bin/zsh");
    expect(shell({}, "linux")).toBe("bash");
    expect(shell({}, "darwin")).toBe("bash");
  });

  it("on Windows without SHELL: pwsh on PATH, else Windows PowerShell, else COMSPEC", () => {
    const env = { Path: "C:\\Windows\\System32;C:\\Program Files\\PowerShell\\7", COMSPEC: "C:\\Windows\\system32\\cmd.exe" };
    const ps5 = "C:\\Windows\\System32\\powershell.exe";
    expect(shell(env, "win32", found(ps5, "C:\\Program Files\\PowerShell\\7\\pwsh.exe"))).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(shell(env, "win32", found(ps5))).toBe(ps5);
    expect(shell(env, "win32", found())).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(shell({}, "win32", found())).toBe("cmd.exe");
  });

  it("on Windows a SHELL that is not a Windows file (Git Bash's /usr/bin/bash) is skipped", () => {
    expect(shell({ SHELL: "/usr/bin/bash", COMSPEC: "cmd.exe" }, "win32", found())).toBe("cmd.exe");
    expect(shell({ SHELL: "C:\\Program Files\\Git\\bin\\bash.exe" }, "win32", found("C:\\Program Files\\Git\\bin\\bash.exe"))).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });
});

describe("node-pty spawn-helper (GH-84)", () => {
  // node-pty 1.1.0 publishes prebuilds/darwin-*/spawn-helper as 0644: macOS spawns fail with "posix_spawnp failed.".
  const pkg = (dir: string) => {
    const root = mkdtempSync(join(tmpdir(), "node-pty-"));
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "spawn-helper"), "");
    chmodSync(join(root, dir, "spawn-helper"), 0o644);
    return { root, helper: join(root, dir, "spawn-helper") };
  };

  it.runIf(posix)("on macOS makes the prebuilt helper executable", () => {
    const { root, helper } = pkg("prebuilds/darwin-arm64");
    expect(fixSpawnHelper(root, "darwin", "arm64")).toBeUndefined();
    expect(statSync(helper).mode & 0o777).toBe(0o755);
  });

  it.runIf(posix)("on macOS also fixes a helper built from source", () => {
    const { root, helper } = pkg("build/Release");
    fixSpawnHelper(root, "darwin", "x64");
    expect(statSync(helper).mode & 0o111).toBe(0o111);
  });

  it.runIf(posix)("leaves other platforms alone", () => {
    const { root, helper } = pkg("prebuilds/linux-x64");
    fixSpawnHelper(root, "linux", "x64");
    expect(statSync(helper).mode & 0o777).toBe(0o644);
  });

  const eperm = () => {
    throw new Error("EPERM");
  };

  it.runIf(posix)("returns the chmod command for a helper it could not make executable", () => {
    const { root, helper } = pkg("prebuilds/darwin-arm64");
    expect(fixSpawnHelper(root, "darwin", "arm64", eperm)).toBe(`chmod +x "${helper}"`);
  });

  // GH-89: a global install owned by root needs sudo.
  it.runIf(posix)("prefixes sudo when the helper is not owned by the current user", () => {
    const { root, helper } = pkg("prebuilds/darwin-arm64");
    const stat = (p: string) => ({ ...statSync(p), uid: process.getuid!() + 1 });
    expect(fixSpawnHelper(root, "darwin", "arm64", eperm, stat)).toBe(`sudo chmod +x "${helper}"`);
  });

  it("resolves node-pty's package root", () => {
    expect(JSON.parse(readFileSync(join(nodePtyRoot(), "package.json"), "utf8")).name).toBe("node-pty");
  });

  // A stand-in for node-pty's IPty: create() reads only these.
  const fakePty = { fd: -1, _socket: { destroyed: false }, onData() {}, onExit() {} };
  const spawnFails = () => {
    throw new Error("posix_spawnp failed.");
  };

  it.runIf(posix)("a spawn error names the chmod command when a helper stays broken", () => {
    const { root, helper } = pkg("build/Release");
    const terms = createTerminals(root, "darwin", spawnFails as never, eperm);
    expect(() => terms.create(tmpdir(), 80, 24, {})).toThrow(`posix_spawnp failed. node-pty's spawn-helper is not executable; run: chmod +x "${helper}"`);
  });

  it.runIf(posix)("a spawn error stays as it is when every helper is executable", () => {
    const { root } = pkg("build/Release");
    const spawn = vi.fn(spawnFails);
    const terms = createTerminals(root, "darwin", spawn as never);
    expect(() => terms.create(tmpdir(), 80, 24, {})).toThrow(/^posix_spawnp failed\.$/);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.runIf(posix)("on Linux a spawn error is thrown at once, without the hint or a retry", () => {
    const { root } = pkg("build/Release");
    const spawn = vi.fn(spawnFails);
    const terms = createTerminals(root, "linux", spawn as never, eperm);
    expect(() => terms.create(tmpdir(), 80, 24, {})).toThrow(/^posix_spawnp failed\.$/);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  // GH-89: node-pty reinstalled while the daemon runs ships the helper 0644 again.
  it.runIf(posix)("on macOS fixes a helper that lost its executable bit since startup and retries the spawn once", () => {
    const { root, helper } = pkg("build/Release");
    const spawn = vi.fn().mockImplementationOnce(spawnFails).mockReturnValue(fakePty);
    const terms = createTerminals(root, "darwin", spawn as never);
    chmodSync(helper, 0o644);
    expect(terms.create(tmpdir(), 80, 24, {}).title).toBe("Terminal 1");
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(statSync(helper).mode & 0o111).toBe(0o111);
  });

  it.runIf(posix)("retries without the hint when only a helper node-pty does not load stays broken", () => {
    const { root, helper } = pkg("build/Release");
    const unused = join(root, "build/Debug/spawn-helper");
    mkdirSync(join(root, "build/Debug"));
    writeFileSync(unused, "");
    chmodSync(unused, 0o644);
    const chmod = (p: string, m: number) => (p === unused ? eperm() : chmodSync(p, m));
    const spawn = vi.fn().mockImplementationOnce(spawnFails).mockReturnValue(fakePty);
    const terms = createTerminals(root, "darwin", spawn as never, chmod as never);
    chmodSync(helper, 0o644);
    expect(terms.create(tmpdir(), 80, 24, {}).title).toBe("Terminal 1");
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe("terminal backpressure", () => {
  it("pauses the shell while a connection's unsent output is above the limit, resumes once it drained", { timeout: 30_000 }, async () => {
    process.env.SHELL = "/bin/sh";
    const terms = createTerminals();
    const info = terms.create(tmpdir(), 80, 24, {});
    const t = terms.get(info.id)!;
    const pause = vi.spyOn(t.pty, "pause");
    const resume = vi.spyOn(t.pty, "resume");
    let backlog = PAUSE_BYTES + 1;
    let got = "";
    terms.attach(t, { output: (d) => (got += d), exit: () => {}, backlog: () => backlog });
    t.pty.write("echo hi\r");
    await vi.waitFor(() => expect(pause).toHaveBeenCalled());
    expect(resume).not.toHaveBeenCalled();
    backlog = 0;
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
    t.pty.write("echo again\r");
    // PowerShell on Windows takes seconds to start.
    await vi.waitFor(() => expect(got).toContain("again"), { timeout: 25_000 });
    // Its fd must be free before the next test takes the lowest free number.
    const exited = new Promise((r) => t.pty.onExit(r));
    terms.close(t);
    await exited;
  });
});

/**
 * Runs `sleep 30` in the shell and resolves once it runs, so the shell reads no more input. Under load the shell may not
 * have read the line yet when the test writes; it would then read the test's input itself. `RE""ADY` in the echoed line
 * is not `READY`: only the command's output matches.
 */
async function sleeping(terminals: ReturnType<typeof createTerminals>, t: NonNullable<ReturnType<ReturnType<typeof createTerminals>["get"]>>) {
  let out = "";
  const ready = new Promise<void>((r) => t.pty.onData((d) => (out += d).includes("READY") && r()));
  terminals.write(t, 'echo RE""ADY; sleep 30\r');
  await ready;
}

// node-pty 1.1.0 retried queued input on the PTY fd after the shell exit closed it, into whatever reused that fd number.
it.runIf(posix)("never writes queued input into a file that reuses the fd of a closed terminal", { timeout: 30_000 }, async () => {
  const terminals = createTerminals();
  const t = terminals.get(terminals.create(tmpdir(), 80, 24, {}).id)!;
  const fd = (t.pty as unknown as { fd: number }).fd;
  const { ino } = fstatSync(fd);
  // The shell does not read while `sleep` runs: the kernel buffer fills and the rest stays queued.
  await sleeping(terminals, t);
  for (let i = 0; i < 8; i++) terminals.write(t, "x".repeat(64 * 1024));
  const exited = new Promise((r) => t.pty.onExit(r));
  const file = join(mkdtempSync(join(tmpdir(), "fd-reuse-")), "victim");
  let grabbed: number | undefined;
  // Take the fd number in the same turn it is freed, before any retry can write to it.
  const grab = () => {
    try {
      if (fstatSync(fd).ino === ino) return void setImmediate(grab);
    } catch {
      grabbed = openSync(file, "w");
    }
  };
  terminals.close(t);
  grab();
  await exited;
  await new Promise((r) => setTimeout(r, 500));
  expect(grabbed).toBe(fd);
  closeSync(grabbed!);
  expect(readFileSync(file, "utf8")).toBe("");
});

it.runIf(posix)("refuses input while MAX_PENDING_INPUT_BYTES wait for the shell to read", { timeout: 30_000 }, async () => {
  const terminals = createTerminals();
  const t = terminals.get(terminals.create(tmpdir(), 80, 24, {}).id)!;
  await sleeping(terminals, t);
  const chunk = "x".repeat(64 * 1024);
  // The kernel takes a varying part of the first chunks (PTY buffers, echo timing): count, do not predict, where it refuses.
  let accepted = 0;
  let refused: string | undefined;
  while (accepted < 64 && !(refused = terminals.write(t, chunk))) accepted++;
  expect(refused).toBe("input_backlog");
  expect(accepted).toBeGreaterThanOrEqual(MAX_PENDING_INPUT_BYTES / chunk.length);
  const exited = new Promise((r) => t.pty.onExit(r));
  terminals.close(t);
  await exited;
});

// Every PTY master has the inode of /dev/ptmx, so a check by fd number and inode took terminal B's master for A's.
it.runIf(posix)("never sends input or a resize of a terminal whose master closed to the terminal that reuses its fd", { timeout: 30_000 }, async () => {
  const terminals = createTerminals();
  const a = terminals.get(terminals.create(tmpdir(), 80, 24, {}).id)!;
  const fd = (a.pty as unknown as { fd: number }).fd;
  await new Promise<void>((r) => a.pty.onData(() => r()));
  // The shell lives on without a PTY fd: node-pty reads EIO and closes the master, onExit does not fire.
  terminals.write(a, "trap '' HUP; exec sleep 20 </dev/null >/dev/null 2>&1\r");
  await vi.waitFor(() => expect(() => fstatSync(fd)).toThrow(), { timeout: 15_000, interval: 5 });
  const b = terminals.get(terminals.create(tmpdir(), 80, 24, {}).id)!;
  expect((b.pty as unknown as { fd: number }).fd).toBe(fd);
  let out = "";
  b.pty.onData((d) => (out += d));
  await new Promise((r) => setTimeout(r, 300));
  expect(terminals.get(a.id)).toBeUndefined();
  expect(terminals.write(a, "echo INJECTED-$((40+2))\r")).toBe("unknown_terminal");
  terminals.resize(a, 33, 11);
  terminals.write(b, "stty size; echo B-$((1+1))\r");
  await vi.waitFor(() => expect(out).toContain("B-2"), { timeout: 10_000 });
  expect(out).not.toContain("INJECTED-42");
  expect(out).toContain("24 80");
  terminals.close(b);
  a.pty.kill("SIGKILL");
});

describe("closing a worktree's terminals", () => {
  /** A fake IPty whose kill() ends the shell after `delay` ms (never when undefined). */
  const ptyExitingAfter = (delay?: number) => () => {
    let onExit: (e: { exitCode: number }) => void = () => {};
    return {
      fd: -1,
      _socket: { destroyed: false },
      onData() {},
      onExit: (cb: typeof onExit) => void (onExit = cb),
      kill: vi.fn(() => delay !== undefined && setTimeout(() => onExit({ exitCode: 0 }), delay)),
    };
  };

  it("closes only the terminals started inside, and resolves once their shells exited", async () => {
    const terms = createTerminals(nodePtyRoot(), "linux", ptyExitingAfter(20) as never);
    const wt = terms.create("/repo/.claude/worktrees/a", 80, 24, {});
    terms.create("/repo/.claude/worktrees/a/sub", 80, 24, {});
    const other = terms.create("/repo", 80, 24, {});
    let done = false;
    const closing = terms.closeIn((cwd) => cwd.startsWith("/repo/.claude/worktrees/a")).then(() => (done = true));
    expect(terms.get(wt.id)).toBeUndefined();
    expect(done).toBe(false);
    await closing;
    expect(terms.list("/repo")).toEqual([other]);
    expect(terms.count()).toBe(1);
  });

  it("stops waiting after the timeout when a shell does not exit", async () => {
    const terms = createTerminals(nodePtyRoot(), "linux", ptyExitingAfter() as never);
    terms.create("/wt", 80, 24, {});
    await terms.closeIn((cwd) => cwd === "/wt", 30);
    expect(terms.count()).toBe(0);
  });

  it("returns at once when no terminal is inside", async () => {
    const terms = createTerminals(nodePtyRoot(), "linux", ptyExitingAfter() as never);
    terms.create("/repo", 80, 24, {});
    await terms.closeIn(() => false, 60_000);
    expect(terms.count()).toBe(1);
  });
});

// GH-266 / GH-268: on Windows node-pty writes input to ConPTY through a net.Socket (`_agent.inSocket`) with no 'error' listener.
// A write that lands while ConPTY closes its pipe fails asynchronously (EAGAIN is libuv's name for ERROR_NO_DATA, "the
// pipe is being closed"; EOF for a closed one), and an unhandled 'error' event ended the daemon. GH-268: the same for
// node-pty's output socket, conout worker and console-list child; a shell that exits by itself leaked its terminal.
describe("Windows terminals: node-pty pipe and worker errors (GH-266, GH-268)", () => {
  /** `live`: stands for the GC roots of the running conout worker thread (its 'message' listener reaches the agent and the pty). */
  const live = new Set<object>();
  /** A fake ConPTY IPty: sockets are plain EventEmitters, so emit("error") throws when nothing listens, as Node does. */
  // `fn`: vitest's vi.fn keeps every mock (and the closure scope of its implementation) alive in a global registry, so the
  // GC tests use plain functions: otherwise the registry, not the daemon, would hold the terminal.
  const conpty = (disposeStopsWorker = true, fn: (impl: (...a: any[]) => any) => any = vi.fn) => {
    const inSocket = Object.assign(new EventEmitter(), { writableLength: 0, destroyed: false, destroy: fn(() => {}) });
    const outSocket = Object.assign(new EventEmitter(), { destroyed: false });
    const worker = new EventEmitter();
    const conout: { _worker: EventEmitter; dispose: any; owner?: object } = { _worker: worker, dispose: fn(() => void (disposeStopsWorker && live.delete(conout))) };
    let onExit: (e: { exitCode: number }) => void = () => {};
    let onData: (d: string) => void = () => {};
    const agent = {
      inSocket,
      _conoutSocketWorker: conout,
      _innerPid: 4242,
      kill: fn(() => {}),
      _getConsoleProcessList: (): Promise<number[]> => Promise.resolve([4242]),
    };
    const pty = {
      fd: undefined,
      _socket: outSocket,
      _agent: agent,
      onData: (cb: typeof onData) => void (onData = cb),
      onExit: (cb: typeof onExit) => void (onExit = cb),
      write: fn(() => {}),
      kill: fn(() => setTimeout(() => onExit({ exitCode: 1 }), 5)),
    };
    conout.owner = pty;
    live.add(conout);
    /** node-pty's first output: its own 'error' handler appears (throws when it is the only listener, like 1.1.0). */
    const ready = (data = "PS> ") => {
      outSocket.on("error", (err) => {
        if (outSocket.listeners("error").length < 2) throw err;
      });
      onData(data);
    };
    return { pty, inSocket, outSocket, worker, conout, agent, ready, shellExits: () => onExit({ exitCode: 1 }) };
  };
  const errno = (code: string) => Object.assign(new Error(`write ${code}`), { code, syscall: "write" });
  const setup = (opts: { fork?: unknown } = {}) => {
    // Each spawn gets its own fake; `fake` is the first terminal's.
    const fakes: ReturnType<typeof conpty>[] = [];
    const terms = createTerminals(nodePtyRoot(), "win32", (() => fakes[fakes.push(conpty()) - 1]!.pty) as never, undefined, opts.fork as never);
    const { id } = terms.create("C:\\repo", 80, 24, {});
    const fake = fakes[0]!;
    const t = terms.get(id)!;
    const output = vi.fn();
    const exit = vi.fn();
    terms.attach(t, { output, exit });
    return { ...fake, terms, t, id, output, exit };
  };

  for (const code of ["EAGAIN", "EOF"]) {
    it(`a ${code} on the input socket ends only that terminal, tells its client, and does not throw`, async () => {
      const { inSocket, pty, terms, id, output, exit, ready } = setup();
      ready();
      const other = terms.create("C:\\repo", 80, 24, {});
      expect(() => inSocket.emit("error", errno(code))).not.toThrow();
      expect(terms.get(id)).toBeUndefined();
      expect(terms.list("C:\\repo").map((t) => t.id)).not.toContain(id);
      expect(terms.list("C:\\repo").map((t) => t.id)).toContain(other.id);
      expect(output).toHaveBeenCalledWith(expect.stringContaining(`write ${code}`));
      expect(pty.kill).toHaveBeenCalled();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(exit).toHaveBeenCalledTimes(1);
    });
  }

  it("an error after the terminal was closed (input still queued when ConPTY shut) is swallowed, with no second kill", () => {
    const { inSocket, pty, terms, t, output, ready } = setup();
    ready();
    output.mockClear(); // the shell's first output
    terms.close(t);
    expect(() => inSocket.emit("error", errno("EAGAIN"))).not.toThrow();
    expect(() => inSocket.emit("error", errno("EOF"))).not.toThrow();
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
  });

  it("refuses input with input_backlog while MAX_PENDING_INPUT_BYTES wait in the input socket", () => {
    const { inSocket, pty, terms, t, ready } = setup();
    ready();
    expect(terms.write(t, "dir\r")).toBeUndefined();
    expect(pty.write).toHaveBeenCalledWith(Buffer.from("dir\r"));
    inSocket.writableLength = MAX_PENDING_INPUT_BYTES - 2;
    expect(terms.write(t, "abc")).toBe("input_backlog");
    expect(pty.write).toHaveBeenCalledTimes(1);
    inSocket.writableLength = 0;
    expect(terms.write(t, "abc")).toBeUndefined();
  });

  it("counts the cap in bytes, not UTF-16 units: a Buffer is written", () => {
    const { inSocket, pty, terms, t, ready } = setup();
    ready();
    inSocket.writableLength = MAX_PENDING_INPUT_BYTES - 3;
    expect(terms.write(t, "é")).toBeUndefined(); // 2 bytes
    expect(terms.write(t, "éé")).toBe("input_backlog"); // 4 bytes, 2 chars
    expect(pty.write).toHaveBeenCalledTimes(1);
    expect(pty.write.mock.calls[0]![0]).toBeInstanceOf(Buffer);
  });

  it("destroys the input socket when the shell exits (node-pty never does), and a later error does nothing", () => {
    const { inSocket, terms, id, exit, output, pty, shellExits, ready } = setup();
    ready();
    output.mockClear();
    shellExits();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(terms.get(id)).toBeUndefined();
    expect(inSocket.destroy).toHaveBeenCalledTimes(1);
    expect(() => inSocket.emit("error", errno("EAGAIN"))).not.toThrow();
    expect(() => inSocket.emit("error", errno("EOF"))).not.toThrow();
    expect(pty.kill).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("without node-pty's Windows internals it still creates, writes and closes, and warns once per process", async () => {
    vi.resetModules(); // a fresh module, so its once-per-process flag is unset
    const mod = await import("../src/terminals.ts");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let exitPlain: (e: { exitCode: number }) => void = () => {};
      const plain = () => ({ fd: undefined, _socket: { destroyed: false }, onData() {}, onExit: (cb: typeof exitPlain) => void (exitPlain = cb), write: vi.fn(), kill: vi.fn() });
      const ptys: ReturnType<typeof plain>[] = [];
      const terms = mod.createTerminals(nodePtyRoot(), "win32", (() => ptys[ptys.push(plain()) - 1]) as never);
      const a = terms.get(terms.create("C:\\repo", 80, 24, {}).id)!;
      const b = terms.get(terms.create("C:\\repo", 80, 24, {}).id)!;
      expect(terms.write(a, "dir\r")).toBeUndefined();
      expect(ptys[0]!.write).toHaveBeenCalledTimes(1);
      expect(() => terms.close(a)).not.toThrow();
      expect(() => terms.close(b)).not.toThrow();
      expect(() => exitPlain({ exitCode: 0 })).not.toThrow();
      const warnings = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes("node-pty internals changed"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("_agent.inSocket");
      expect(warnings[0]).toContain("_agent._conoutSocketWorker");
    } finally {
      warn.mockRestore();
    }
  });

  it("a synchronous write error is write_failed, not a throw", () => {
    const { pty, terms, t, ready } = setup();
    ready();
    pty.write.mockImplementation(() => {
      throw errno("EPIPE");
    });
    expect(terms.write(t, "x")).toBe("write_failed");
  });

  describe("a shell that exits by itself (GH-268)", () => {
    it("a shell that exits by itself stops node-pty's conout worker", () => {
      const { terms, id, exit, inSocket, conout, ready, shellExits } = setup();
      ready();
      shellExits();
      expect(terms.get(id)).toBeUndefined();
      expect(conout.dispose).toHaveBeenCalledTimes(1);
      expect(inSocket.destroy).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    });

    /** Creates inside a function: the test keeps only a WeakRef and the exit trigger, so nothing else holds the terminal. */
    const spawnWeak = (disposeStopsWorker: boolean) => {
      const fake = conpty(disposeStopsWorker, (impl) => impl);
      const terms = createTerminals(nodePtyRoot(), "win32", (() => fake.pty) as never);
      const { id } = terms.create("C:\\repo", 80, 24, {});
      fake.ready();
      return { ref: new WeakRef(terms.get(id)!), exits: fake.shellExits };
    };
    const collected = async (disposeStopsWorker: boolean) => {
      live.clear();
      let held: { ref: WeakRef<object>; exits: (() => void) | undefined } | undefined = spawnWeak(disposeStopsWorker);
      const ref = held.ref;
      held.exits!();
      held = undefined;
      await new Promise((r) => setTimeout(r, 0)); // WeakRef targets live until the end of the current job
      gc();
      return ref.deref() === undefined;
    };

    it("a shell that exits by itself leaves no terminal in memory (weak reference, forced GC)", async () => {
      expect(await collected(true)).toBe(true);
    });

    it("control: a conout worker that is never disposed keeps the terminal", async () => {
      expect(await collected(false)).toBe(false);
    });
  });

  describe("an error from node-pty's pipes or workers ends at most that terminal (GH-268)", () => {
    it("an output socket error before the first output ends only that terminal with a notice, through the agent (-1)", () => {
      const { outSocket, terms, id, output, exit, agent, pty, inSocket, conout } = setup();
      const other = terms.create("C:\\repo", 80, 24, {});
      expect(() => outSocket.emit("error", errno("ENOENT"))).not.toThrow();
      expect(terms.get(id)).toBeUndefined();
      expect(terms.list("C:\\repo").map((t) => t.id)).toEqual([other.id]);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("terminal output failed"));
      expect(output).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));
      expect(agent.kill).toHaveBeenCalledTimes(1);
      expect(pty.kill).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(-1);
      expect(inSocket.destroy).toHaveBeenCalled();
      expect(conout.dispose).toHaveBeenCalled();
    });

    it("an output socket error after the first output closes the terminal and node-pty's own handler does not throw", async () => {
      const { outSocket, pty, exit, ready } = setup();
      ready();
      expect(() => outSocket.emit("error", errno("ECONNRESET"))).not.toThrow();
      expect(pty.kill).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(exit).toHaveBeenCalledTimes(1);
    });

    it("EIO on the output socket is left to node-pty", () => {
      const { outSocket, terms, id, output, pty, ready } = setup();
      ready();
      output.mockClear();
      expect(() => outSocket.emit("error", errno("EIO"))).not.toThrow();
      expect(terms.get(id)).toBeDefined();
      expect(output).not.toHaveBeenCalled();
      expect(pty.kill).not.toHaveBeenCalled();
    });

    it("an output socket or worker error after the terminal closed is swallowed", () => {
      const { outSocket, worker, terms, t, pty, output, ready } = setup();
      ready();
      output.mockClear();
      terms.close(t);
      expect(() => outSocket.emit("error", errno("ECONNRESET"))).not.toThrow();
      expect(() => worker.emit("error", new Error("boom"))).not.toThrow();
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(output).not.toHaveBeenCalled();
    });

    it("a conout worker error ends only that terminal with a notice", () => {
      const { worker, terms, id, output, exit, agent } = setup();
      const msg = "connect ENOENT \\\\.\\pipe\\conpty-1-out";
      expect(() => worker.emit("error", new Error(msg))).not.toThrow();
      expect(terms.get(id)).toBeUndefined();
      expect(output).toHaveBeenCalledWith(expect.stringContaining(msg));
      expect(agent.kill).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(-1);
    });

    it("a conout worker error after the first output closes the terminal through pty.kill", () => {
      const { worker, pty, ready, output } = setup();
      ready();
      expect(() => worker.emit("error", new Error("boom"))).not.toThrow();
      expect(pty.kill).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });
  });

  describe("node-pty's console-list child (GH-268)", () => {
    const child = () => Object.assign(new EventEmitter(), { kill: vi.fn() });
    const listPid = "4242";

    it("a console-list child that fails falls back to the shell PID and does not throw", async () => {
      const c = child();
      const fork = vi.fn(() => c);
      const { agent } = setup({ fork });
      const list = agent._getConsoleProcessList();
      expect(fork).toHaveBeenCalledWith(join(nodePtyRoot(), "lib", "conpty_console_list_agent"), [listPid]);
      expect(() => c.emit("error", errno("EAGAIN"))).not.toThrow();
      await expect(list).resolves.toEqual([4242]);
    });

    it("a fork that throws falls back to the shell PID", async () => {
      const { agent } = setup({
        fork: () => {
          throw errno("EMFILE");
        },
      });
      await expect(agent._getConsoleProcessList()).resolves.toEqual([4242]);
    });

    it("the console-list child's answer is used, and its timeout kills it otherwise", async () => {
      vi.useFakeTimers();
      try {
        const answering = child();
        const silent = child();
        const fork = vi.fn().mockReturnValueOnce(answering).mockReturnValueOnce(silent);
        const { agent } = setup({ fork });
        const first = agent._getConsoleProcessList();
        answering.emit("message", { consoleProcessList: [1, 2] });
        await expect(first).resolves.toEqual([1, 2]);
        vi.advanceTimersByTime(5000);
        expect(answering.kill).not.toHaveBeenCalled();
        const second = agent._getConsoleProcessList();
        vi.advanceTimersByTime(5000);
        expect(silent.kill).toHaveBeenCalled();
        await expect(second).resolves.toEqual([4242]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("input before the shell's first output (GH-268)", () => {
    it("input before the shell's first output counts against MAX_PENDING_INPUT_BYTES", () => {
      const { pty, terms, t, ready } = setup();
      expect(terms.write(t, "x".repeat(MAX_PENDING_INPUT_BYTES - 1))).toBeUndefined();
      expect(terms.write(t, "ab")).toBe("input_backlog");
      expect(pty.write).toHaveBeenCalledTimes(1);
      ready(); // node-pty flushes its deferred input into the socket now
      expect(terms.write(t, "ab")).toBeUndefined();
    });

    it("early input is counted in bytes", () => {
      const { terms, t } = setup();
      expect(terms.write(t, "x".repeat(MAX_PENDING_INPUT_BYTES - 3))).toBeUndefined();
      expect(terms.write(t, "éé")).toBe("input_backlog");
    });
  });
});

describe("node-pty Windows internals (GH-268)", () => {
  // Fails on a node-pty upgrade that renames what windowsInternals() in terminals.ts guards: recheck it, then update this test.
  const src = (f: string) => readFileSync(join(nodePtyRoot(), "lib", f), "utf8");

  it("node-pty still has the Windows internals the daemon guards", () => {
    const terminal = src("windowsTerminal.js");
    expect(terminal).toMatch(/_?this\._socket = _?this\._agent\.outSocket/);
    expect(terminal).toMatch(/_deferreds/);
    const agent = src("windowsPtyAgent.js");
    expect(agent).toMatch(/_conoutSocketWorker/);
    expect(agent).toMatch(/_getConsoleProcessList/);
    expect(agent).toMatch(/"inSocket"|get inSocket/);
    expect(agent).toMatch(/_innerPid/);
    expect(agent).toMatch(/conpty_console_list_agent/);
    const conout = src("windowsConoutConnection.js");
    expect(conout).toMatch(/this\._worker = new/);
    expect(conout).toMatch(/prototype\.dispose/);
    expect(statSync(join(nodePtyRoot(), "lib", "conpty_console_list_agent.js")).isFile()).toBe(true);
  });
});
