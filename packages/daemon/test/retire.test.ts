import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeDaemonFile } from "../src/ctl/daemon-file.ts";
import { CtlError } from "../src/ctl/connect.ts";
import { retireAttachHub } from "../src/ctl/retire.ts";

const withFile = (startedBy?: "attach") => {
  const dir = mkdtempSync(join(tmpdir(), "cu-retire-"));
  writeDaemonFile(dir, { port: 5, pid: 77, version: "1", startedAt: "a", ...(startedBy && { startedBy }) });
  return dir;
};
const setup = (dir: string, o: { alive?: (n: number) => boolean; ask?: () => Promise<{ installed: string; waitingFor: number }> } = {}) => {
  const ask = vi.fn(o.ask ?? (async () => ({ installed: "1", waitingFor: 0 })));
  const log = vi.fn();
  const run = () => retireAttachHub({ dir, alive: o.alive ?? (() => true), ask, token: () => "tok", log, pollMs: 5 });
  return { ask, log, run };
};

describe("retireAttachHub", () => {
  it("no daemon.json or a dead pid: returns at once, no request", async () => {
    const a = setup(mkdtempSync(join(tmpdir(), "cu-retire-")));
    await a.run();
    const b = setup(withFile("attach"), { alive: () => false });
    await b.run();
    expect(a.ask).not.toHaveBeenCalled();
    expect(b.ask).not.toHaveBeenCalled();
  });
  it("a Hub without startedBy is never asked", async () => {
    const s = setup(withFile());
    await s.run();
    expect(s.ask).not.toHaveBeenCalled();
  });
  it("a pid that answers as no Hub (stale daemon.json, pid reused) is not waited for", async () => {
    const s = setup(withFile("attach"), { ask: async () => Promise.reject(new CtlError(3, "not_running", "no daemon")) });
    await s.run();
    expect(s.log).not.toHaveBeenCalled();
  });
  it("asks once, says waiting only when turns run, resolves when the pid dies", async () => {
    for (const waitingFor of [0, 2]) {
      let polls = 0;
      const s = setup(withFile("attach"), { ask: async () => ({ installed: "1", waitingFor }), alive: () => ++polls < 4 });
      await s.run();
      expect(s.ask).toHaveBeenCalledTimes(1);
      expect(s.ask).toHaveBeenCalledWith(5, "tok");
      expect(s.log).toHaveBeenCalledTimes(waitingFor ? 1 : 0);
    }
  });
  it("a failed request is fine when the pid died, else it rejects", async () => {
    const fail = async () => {
      throw new Error("closed");
    };
    let polls = 0;
    await setup(withFile("attach"), { ask: fail, alive: () => ++polls < 2 }).run();
    await expect(setup(withFile("attach"), { ask: fail }).run()).rejects.toThrow("closed");
  });
});
