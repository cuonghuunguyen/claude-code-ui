import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runSide } from "../src/sides.ts";

afterEach(() => vi.unstubAllEnvs());

it("side git: the side's own GIT_* environment never reaches git, only what the hub sent", async () => {
  vi.stubEnv("GIT_DIR", "/elsewhere/.git");
  vi.stubEnv("GIT_WORK_TREE", "/elsewhere");
  const input = new PassThrough();
  const output = new PassThrough();
  const git = vi.fn(async () => ({ stdout: Buffer.from(""), stderr: "" }));
  runSide({ input, output, accept: () => {}, git });
  input.write(JSON.stringify({ g: 1, git: { cwd: "/r", args: ["status"], env: { GIT_TERMINAL_PROMPT: "0" } } }) + "\n");
  await vi.waitFor(() => expect(git).toHaveBeenCalled());
  const env = (git.mock.calls[0] as unknown as [{ env: Record<string, string> }])[0].env;
  expect(env.GIT_DIR).toBeUndefined();
  expect(env.GIT_WORK_TREE).toBeUndefined();
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
});

it("side git: a git error with signal null is answered, not dropped by the frame schema", async () => {
  const { parseSideFrame } = await import("../src/side-frame.ts");
  expect(parseSideFrame(JSON.stringify({ g: 1, out: "", err: "fatal", error: { message: "x", code: 1, killed: false, signal: null } }))).toMatchObject({ frame: { kind: "git", g: 1 } });
});
