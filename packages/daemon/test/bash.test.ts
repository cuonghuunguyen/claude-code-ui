import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BASH_KILL_GRACE_MS, runBash, shellArgs } from "../src/bash.ts";

const posix = it.skipIf(process.platform === "win32");
const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "bash-")));

describe("runBash", () => {
  posix("runs the command in cwd with the user's shell and reports stdout, stderr and the exit code", async () => {
    const cwd = dir();
    const r = await runBash("pwd; echo err >&2; exit 3", cwd, () => {}).done;
    expect(r).toEqual({ stdout: `${cwd}\n`, stderr: "err\n", exitCode: 3, stopped: false });
  });

  posix("keeps the daemon's PORT and CLAUDE_UI_* out of the env", async () => {
    process.env.CLAUDE_UI_X = "1";
    process.env.PORT = "1234";
    try {
      const r = await runBash("env", dir(), () => {}).done;
      expect(r.stdout).not.toMatch(/^(CLAUDE_UI_X|PORT)=/m);
    } finally {
      delete process.env.CLAUDE_UI_X;
      delete process.env.PORT;
    }
  });

  posix("caps each stream at maxChars and marks the cut, still drains the rest", async () => {
    const r = await runBash("yes | head -c 200000", dir(), () => {}, { maxChars: 1000 }).done;
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith("y\ny\n")).toBe(true);
    expect(r.stdout).toContain("output truncated at 1000 characters");
    expect(r.stdout.length).toBeLessThan(1100);
  });

  posix("kill() stops the whole process group: stopped true", async () => {
    const run = runBash("sleep 30 & sleep 30; wait", dir(), () => {});
    const t = Date.now();
    setTimeout(() => run.kill(), 100);
    const r = await run.done;
    expect(r.stopped).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  posix("times out", async () => {
    const r = await runBash("sleep 5", dir(), () => {}, { timeoutMs: 200 }).done;
    expect(r.stopped).toBe(true);
    expect(r.stderr).toMatch(/Timed out/);
  });

  posix("a missing cwd is an error result, not a throw", async () => {
    const r = await runBash("ls", join(dir(), "gone"), () => {}).done;
    expect(r.exitCode).toBe(127);
  });
});

describe("runBash release and records", () => {
  posix("a setsid background process holding the pipe does not keep the command running: kill() releases within the drain time", async () => {
    const run = runBash("setsid sleep 30 & sleep 30", dir(), () => {});
    const t = Date.now();
    setTimeout(() => run.kill(), 100);
    const r = await run.done;
    expect(r.stopped).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  posix("a setsid process outliving a command that exited does not block the result", async () => {
    const t = Date.now();
    const r = await runBash("setsid sleep 30 & echo done", dir(), () => {}).done;
    expect(r.stdout).toBe("done\n");
    expect(Date.now() - t).toBeLessThan(3000);
  });

  posix("a killed command reports 128 + signal and ends stderr with Stopped by user; a timeout says Timed out", async () => {
    const run = runBash("echo part; sleep 30", dir(), () => {});
    setTimeout(() => run.kill(), 200);
    const r = await run.done;
    expect(r).toMatchObject({ stopped: true, exitCode: 143, stdout: "part\n", stderr: "Stopped by user" });
    const t = await runBash("sleep 5", dir(), () => {}, { timeoutMs: 100 }).done;
    expect(t.stderr).toBe("Timed out after 0 s");
    expect(t.exitCode).toBe(143);
  });

  posix("the cap does not split a surrogate pair", async () => {
    const r = await runBash("printf '😀😀😀'", dir(), () => {}, { maxChars: 3 }).done;
    expect(r.stdout.startsWith("😀")).toBe(true);
    expect(r.stdout.slice(0, 2)).toBe("😀");
    expect(r.stdout).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  posix("output callbacks come only for new output", async () => {
    const calls: string[] = [];
    await runBash("echo a", dir(), (o) => calls.push(o)).done;
    expect(calls).toEqual(["a\n"]);
  });
});

describe("runBash TERM-proof child", () => {
  posix("a child ignoring TERM is SIGKILLed after the grace period, though the shell and the drain are long done", async () => {
    const cwd = dir();
    const run = runBash("(trap '' TERM; exec sleep 31) & echo $! > pid; sleep 31", cwd, () => {});
    await new Promise((r) => setTimeout(r, 300));
    const pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    run.kill();
    await run.done;
    await new Promise((r) => setTimeout(r, BASH_KILL_GRACE_MS + 500));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 10_000);
});

describe("shellArgs", () => {
  it("picks the command flag by shell", () => {
    expect(shellArgs("/bin/zsh", "x")).toEqual(["-c", "x"]);
    expect(shellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "x")).toEqual(["-NoProfile", "-Command", "x"]);
    expect(shellArgs("C:\\Windows\\System32\\cmd.exe", "x")).toEqual(["/d", "/s", "/c", "x"]);
  });
});
