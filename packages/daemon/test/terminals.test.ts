import { chmodSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTerminals, fixSpawnHelper, MAX_PENDING_INPUT_BYTES, nodePtyRoot, PAUSE_BYTES, shell, trimScrollback } from "../src/terminals.ts";

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

// GH-266: on Windows node-pty writes input to ConPTY through a net.Socket (`_agent.inSocket`) with no 'error' listener.
// A write that lands while ConPTY closes its pipe fails asynchronously (EAGAIN is libuv's name for ERROR_NO_DATA, "the
// pipe is being closed"; EOF for a closed one), and an unhandled 'error' event ended the daemon.
describe("Windows terminal input socket errors (GH-266)", () => {
  /** A fake ConPTY IPty: `inSocket` is a plain EventEmitter, so emit("error") throws when nothing listens, as Node does. */
  const conpty = () => {
    const inSocket = Object.assign(new EventEmitter(), { writableLength: 0, destroyed: false });
    let onExit: (e: { exitCode: number }) => void = () => {};
    const pty = {
      fd: undefined,
      _socket: { destroyed: false },
      _agent: { inSocket },
      onData() {},
      onExit: (cb: typeof onExit) => void (onExit = cb),
      write: vi.fn(),
      kill: vi.fn(() => setTimeout(() => onExit({ exitCode: 1 }), 5)),
    };
    return { pty, inSocket, exit: () => onExit({ exitCode: 1 }) };
  };
  const errno = (code: string) => Object.assign(new Error(`write ${code}`), { code, syscall: "write" });
  const setup = () => {
    // Each spawn gets its own fake; `fake` is the first terminal's.
    const fakes: ReturnType<typeof conpty>[] = [];
    const terms = createTerminals(nodePtyRoot(), "win32", (() => fakes[fakes.push(conpty()) - 1]!.pty) as never);
    const { id } = terms.create("C:\repo", 80, 24, {});
    const fake = fakes[0]!;
    const t = terms.get(id)!;
    const output = vi.fn();
    const exit = vi.fn();
    terms.attach(t, { output, exit });
    return { ...fake, terms, t, id, output, exit };
  };

  for (const code of ["EAGAIN", "EOF"]) {
    it(`a ${code} on the input socket ends only that terminal, tells its client, and does not throw`, async () => {
      const { inSocket, pty, terms, id, output, exit } = setup();
      const other = terms.create("C:\repo", 80, 24, {});
      expect(() => inSocket.emit("error", errno(code))).not.toThrow();
      expect(terms.get(id)).toBeUndefined();
      expect(terms.list("C:\repo").map((t) => t.id)).not.toContain(id);
      expect(terms.list("C:\repo").map((t) => t.id)).toContain(other.id);
      expect(output).toHaveBeenCalledWith(expect.stringContaining(`write ${code}`));
      expect(pty.kill).toHaveBeenCalled();
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    });
  }

  it("an error after the terminal was closed (input still queued when ConPTY shut) is swallowed, with no second kill", () => {
    const { inSocket, pty, terms, t, output } = setup();
    terms.close(t);
    expect(() => inSocket.emit("error", errno("EAGAIN"))).not.toThrow();
    expect(() => inSocket.emit("error", errno("EOF"))).not.toThrow();
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(output).not.toHaveBeenCalled();
  });

  it("refuses input with input_backlog while MAX_PENDING_INPUT_BYTES wait in the input socket", () => {
    const { inSocket, pty, terms, t } = setup();
    expect(terms.write(t, "dir\r")).toBeUndefined();
    expect(pty.write).toHaveBeenCalledWith("dir\r");
    inSocket.writableLength = MAX_PENDING_INPUT_BYTES - 2;
    expect(terms.write(t, "abc")).toBe("input_backlog");
    expect(pty.write).toHaveBeenCalledTimes(1);
    inSocket.writableLength = 0;
    expect(terms.write(t, "abc")).toBeUndefined();
  });

  it("a synchronous write error is write_failed, not a throw", () => {
    const { pty, terms, t } = setup();
    pty.write.mockImplementation(() => {
      throw errno("EPIPE");
    });
    expect(terms.write(t, "x")).toBe("write_failed");
  });
});
