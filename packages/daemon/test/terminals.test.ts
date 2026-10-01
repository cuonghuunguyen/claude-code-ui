import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createTerminals, PAUSE_BYTES, trimScrollback } from "../src/terminals.ts";

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
