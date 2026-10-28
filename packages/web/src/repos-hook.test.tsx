// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { GitRepo } from "@claude-ui/protocol";
import { useRepos } from "./repos.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(null)));

const repo: GitRepo = { path: "/p/api", rel: "api", kind: "nested" };
type P = { cwd?: string; connected?: boolean; openFiles?: string[]; seq?: number; fresh?: number };
function setup(reply: (m: { type: string }) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const client = { request: vi.fn(async (m: Record<string, unknown>) => (sent.push(m), reply(m as { type: string }))) } as never;
  let out: ReturnType<typeof useRepos> = { repos: undefined };
  const Probe = ({ cwd = "/p", connected = true, openFiles = [], seq = 0, fresh = 0 }: P) => ((out = useRepos(client, cwd, { connected, openFiles, seq, fresh })), null);
  const render = (p: P = {}) => act(async () => root.render(<Probe {...p} />));
  return { sent, render, out: () => out };
}

it("useRepos sends git.repos with openFiles, re-asks on seq, fresh and cwd, and gives null for a reply without repos", async () => {
  const t = setup(() => ({ repos: [repo] }));
  await t.render({ openFiles: ["/p/b.ts", "/p/a.ts"] });
  expect(t.sent).toEqual([{ type: "git.repos", cwd: "/p", openFiles: ["/p/a.ts", "/p/b.ts"] }]);
  expect(t.out().repos).toEqual([repo]);
  await t.render({ openFiles: ["/p/a.ts", "/p/b.ts"] });
  expect(t.sent).toHaveLength(1);
  await t.render({ openFiles: ["/p/a.ts", "/p/b.ts"], seq: 1 });
  expect(t.sent[1]).not.toHaveProperty("fresh");
  await t.render({ openFiles: ["/p/a.ts", "/p/b.ts"], seq: 1, fresh: 1 });
  expect(t.sent[2]).toMatchObject({ fresh: true });
  await t.render({ cwd: "/q", seq: 1, fresh: 1 });
  expect(t.sent[3]).toEqual({ type: "git.repos", cwd: "/q" });
  expect(t.sent[3]).not.toHaveProperty("fresh");
  const old = setup(() => ({}));
  await old.render();
  expect(old.out().repos).toBeNull();
});

it("useRepos waits while disconnected, is unknown until the reply, and a failing request gives null", async () => {
  const t = setup(() => ({ repos: [] }));
  await t.render({ connected: false });
  expect(t.sent).toEqual([]);
  expect(t.out().repos).toBeUndefined();
  const failing = setup(() => Promise.reject(Object.assign(new Error("x"), { code: "internal" })));
  await failing.render();
  expect(failing.out().repos).toBeNull();
  const denied = setup(() => Promise.reject(Object.assign(new Error("x"), { code: "cwd_not_allowed" })));
  await denied.render();
  expect(denied.out().repos).toEqual([]);
});
