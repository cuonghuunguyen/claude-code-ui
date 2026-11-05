import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const root = realpathSync(mkdtempSync(join(tmpdir(), "lhs-")));
const http = createDaemon({ webRoot: root, roots: [root], query: fakeQuery as never, token, historyDir: join(root, ".history") });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const port = (http.address() as AddressInfo).port;
afterAll(() => void http.close());

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const request = (msg: object) =>
    new Promise<any>((resolve) => {
      const reqId = Math.random().toString(36);
      ws.send(JSON.stringify({ ...msg, reqId }));
      const t = setInterval(() => {
        const m = inbox.find((x) => (x.type === "reply" || x.type === "error") && x.reqId === reqId);
        if (m) (clearInterval(t), resolve(m));
      }, 5);
    });
  return new Promise<{ request: typeof request; ws: WebSocket }>((resolve) => ws.once("open", () => resolve({ request, ws })));
}

describe("local history over the wire", () => {
  it("fs.write stores the replaced content; list, read, rename, create, delete work; restore snapshots first", async () => {
    const file = join(root, "a.txt");
    writeFileSync(file, "one");
    const c = await client();
    await c.request({ type: "fs.write", path: file, content: "two" });
    const l = (await c.request({ type: "history.list", path: file })).result.entries;
    expect(l).toMatchObject([{ reason: "save", size: 3 }]);
    expect((await c.request({ type: "history.read", path: file, id: l[0].id })).result.content).toBe("one");

    const r = await c.request({ type: "history.restore", path: file, id: l[0].id });
    expect(r.result.mtime).toBeTypeOf("number");
    expect(readFileSync(file, "utf8")).toBe("one");
    const after = (await c.request({ type: "history.list", path: file })).result.entries;
    expect(after.map((e: { reason: string }) => e.reason)).toEqual(["restore", "save"]);
    expect((await c.request({ type: "history.read", path: file, id: after[0].id })).result.content).toBe("two");

    const named = (await c.request({ type: "history.create", path: file, label: "two as is" })).result.entry;
    expect(named).toMatchObject({ reason: "named", label: "two as is" });
    expect(await c.request({ type: "history.rename", path: file, id: named.id, label: "x".repeat(101) })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "history.rename", path: file, id: named.id, label: "ok" })).toMatchObject({ result: {} });

    expect(await c.request({ type: "history.delete", path: file, id: named.id })).toMatchObject({ result: {} });
    expect(await c.request({ type: "history.read", path: file, id: named.id })).toMatchObject({ code: "not_found" });
    expect(await c.request({ type: "history.restore", path: file, id: l[0].id, baseMtime: 1 })).toMatchObject({ code: "conflict" });
    c.ws.close();
  });

  it("refuses a path outside the roots", async () => {
    const c = await client();
    for (const type of ["history.list", "history.read", "history.restore", "history.delete", "history.create", "history.rename"])
      expect(await c.request({ type, path: join(tmpdir(), "nope.txt"), id: "x", label: "x" })).toMatchObject({ code: "path_not_allowed" });
    c.ws.close();
  });

  it("a git write that calls before(path, 'rollback') can be undone with restore", async () => {
    // Acceptance criterion "Rollback, then Restore", daemon level (the Rollback UI ships with the git write tickets).
    const { createLocalHistory } = await import("../src/local-history.ts");
    const dir = join(root, ".h2");
    const file = join(root, "r.txt");
    writeFileSync(file, "hunk kept");
    const h = createLocalHistory({ dir, settings: () => ({ enabled: true, exclude: [] }), allowed: (p) => p });
    h.before(file, "rollback");
    writeFileSync(file, "rolled back");
    const [e] = await h.list(file);
    expect(e).toMatchObject({ reason: "rollback" });
    expect(await h.read(file, e!.id)).toBe("hunk kept");
  });

  it("git.log with a path lists only the commits that touch the file", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1");
    writeFileSync(join(repo, "b.txt"), "1");
    git("add", ".");
    git("commit", "-q", "-m", "both");
    writeFileSync(join(repo, "b.txt"), "2");
    git("commit", "-q", "-am", "only b");
    writeFileSync(join(repo, "a.txt"), "2");
    git("commit", "-q", "-am", "a again");
    const c = await client();
    const r = await c.request({ type: "git.log", cwd: repo, path: "a.txt" });
    expect(r.result.log.commits.map((x: { subject: string }) => x.subject)).toEqual(["a again", "both"]);
    expect((await c.request({ type: "git.log", cwd: repo, path: "../x" })).code).toBe("bad_request");
    c.ws.close();
  });
});
