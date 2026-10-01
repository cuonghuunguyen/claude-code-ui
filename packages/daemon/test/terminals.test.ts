import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTerminals, MAX_PENDING_INPUT_BYTES, PAUSE_BYTES, trimScrollback } from "../src/terminals.ts";

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

describe("terminal backpressure", () => {
  it("pauses the shell while a connection's unsent output is above the limit, resumes once it drained", async () => {
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
    await vi.waitFor(() => expect(got).toContain("again"));
    terms.close(t);
  });
});

// node-pty 1.1.0 retried queued input on the PTY fd after the shell exit closed it, into whatever reused that fd number.
it("never writes queued input into a file that reuses the fd of a closed terminal", { timeout: 30_000 }, async () => {
  const terminals = createTerminals();
  const t = terminals.get(terminals.create(tmpdir(), 80, 24, {}).id)!;
  const fd = (t.pty as unknown as { fd: number }).fd;
  const { ino } = fstatSync(fd);
  await new Promise<void>((r) => t.pty.onData(() => r()));
  // The shell does not read while `sleep` runs: the kernel buffer fills and the rest stays queued.
  terminals.write(t, "sleep 30\r");
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

it("refuses input while MAX_PENDING_INPUT_BYTES wait for the shell to read", { timeout: 30_000 }, async () => {
  const terminals = createTerminals();
  const t = terminals.get(terminals.create(tmpdir(), 80, 24, {}).id)!;
  await new Promise<void>((r) => t.pty.onData(() => r()));
  terminals.write(t, "sleep 30\r");
  const chunk = "x".repeat(64 * 1024);
  for (let i = 0; i < MAX_PENDING_INPUT_BYTES / chunk.length; i++) expect(terminals.write(t, chunk)).toBe(true);
  expect(terminals.write(t, chunk)).toBe(false);
  const exited = new Promise((r) => t.pty.onExit(r));
  terminals.close(t);
  await exited;
});
