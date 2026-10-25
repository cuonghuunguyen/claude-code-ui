import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { dismissRemoteResult, forgetRemoteOps, remoteOpOf, runRemoteOp } from "./git-remote-ops.ts";
import { refsOf } from "./git-refs.ts";

afterEach(forgetRemoteOps);
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
function fake() {
  const sent: { type: string; cwd: string }[] = [];
  const pending: Pending[] = [];
  const request = vi.fn((m: { type: string; cwd: string }) => {
    sent.push(m);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  return { client: { request } as unknown as ReturnType<typeof connect>, sent, pending };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const read = remoteOpOf;

it("runRemoteOp refuses a second op for the same repository and allows another repository", () => {
  const f = fake();
  expect(runRemoteOp(f.client, { type: "git.fetch", cwd: "/p" }, "done", "run")).toBe(true);
  expect(runRemoteOp(f.client, { type: "git.fetch", cwd: "/p" }, "done", "run")).toBe(false);
  expect(runRemoteOp(f.client, { type: "git.fetch", cwd: "/p/lib" }, "done", "run")).toBe(true);
  expect(f.sent.map((m) => m.cwd)).toEqual(["/p", "/p/lib"]);
  expect(read("/p").running).toBe("run");
});

it("a success notes the refs stamp under the repository path and sets the result", async () => {
  const f = fake();
  runRemoteOp(f.client, { type: "git.fetch", cwd: "/ops-a" }, "Fetched", "Fetching");
  f.pending[0]!.resolve({ remote: { output: "out", refs: "s9" } });
  await flush();
  expect(refsOf("/ops-a")).toBe("s9");
  expect(refsOf("/ops-b")).toBeUndefined();
  expect(read("/ops-a")).toEqual({ running: undefined, result: { ok: true, text: "Fetched", output: "out" }, settled: 1 });
});

it("a failure keeps git's message; Dismiss clears only that repository", async () => {
  const f = fake();
  runRemoteOp(f.client, { type: "git.fetch", cwd: "/a" }, "d", "r");
  runRemoteOp(f.client, { type: "git.fetch", cwd: "/b" }, "d", "r");
  f.pending[0]!.reject({ message: "boom" });
  f.pending[1]!.resolve({ remote: { output: "", refs: null } });
  await flush();
  expect(read("/a").result).toEqual({ ok: false, text: "boom" });
  dismissRemoteResult("/a");
  expect(read("/a").result).toBeUndefined();
  expect(read("/b").result?.ok).toBe(true);
});
