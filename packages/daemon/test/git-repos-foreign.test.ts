import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULTS } from "../src/settings.ts";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";

vi.mock("../src/remote-path.ts", async (orig) => ({ ...(await orig<typeof import("../src/remote-path.ts")>()), foreignPointer: (v: string) => v.startsWith("//foreign/") }));
const { listRepos } = await import("../src/git.ts");

it("a foreign UNC or device gitdir is listed outsideRoots, never resolved and never read", async () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "foreign-")));
  mkdirSync(join(d, "x"));
  writeFileSync(join(d, "x/.git"), "gitdir: //foreign/share/g\n");
  mkdirSync(join(d, "y/.git/objects/info"), { recursive: true });
  writeFileSync(join(d, "y/.git/objects/info/alternates"), "//foreign/share/o\n");
  const calls: string[][] = [];
  setGitRunner((o) => (calls.push(o.args), threadRunner(o)));
  try {
    const r = await listRepos(d, { settings: DEFAULTS.git, allowed: () => true });
    expect(r.repos.map((x) => [x.rel, x.outsideRoots, x.branch])).toEqual([["x", true, undefined], ["y", true, undefined]]);
    expect(calls).toEqual([]);
  } finally {
    setGitRunner(undefined);
  }
});
