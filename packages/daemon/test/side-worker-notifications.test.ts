// GH-387: a side runs its own notifier; with the hub's "Notifications from workers" off, its workers push nothing through the
// hub's forwardSidePush, an escalated request still does. In-process side (no real WSL or Docker), so it runs on Windows too.
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, expect, it, vi } from "vitest";
import type { PushPayload } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { createSides, forwardSidePush, runSide, wslSide, type SideProcess } from "../src/sides.ts";
import { permissionQuery } from "./fake-query.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const webRoot = dir("swn-web-");
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const root = dir("swn-side-");
const cfg = dir("swn-cfg-");

const settings = createSettings({ file: join(cfg, "settings.json") });
settings.set({ orchestration: { enabled: true, workerNotifications: false } });
let hostPush: (p: PushPayload) => void = () => {};
const side = createDaemon({
  webRoot,
  token: "",
  roots: [root],
  appSettings: settings,
  query: permissionQuery as never,
  projects: createProjects(),
  settingsFile: join(cfg, "sessions.json"),
  push: { publicKey: "", subscribe: () => false, send: async (p: PushPayload) => hostPush(p) },
  history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
});
const spawnSide = async (): Promise<SideProcess> => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  hostPush = runSide({ input: stdin, output: stdout, accept: side.accept, onEnd: () => exit.emit("exit", 0) }).push;
  return { stdin, stdout, stderr: new PassThrough(), kill: () => stdin.end(), on: (e, l) => exit.on(e, l) };
};
const hubPushes: PushPayload[] = [];
const hub = createSides({ targets: [wslSide("Ubuntu")], spawn: spawnSide, onPush: forwardSidePush({ send: async (p) => void hubPushes.push(p) }), posixLocal: true });
afterAll(() => void (side.close(), hub.close()));

it("a worker on a side with the setting off sends no push through the hub; an escalated request does (GH-387)", async () => {
  await hub.start("wsl:Ubuntu");
  const coord = side.orchestration.tools("00000000-0000-4000-8000-0000000000c0");
  const call = async (name: string, input: object) => JSON.parse(((await coord.find((t) => t.name === name)!.handler(input as never, {})) as { content: { text: string }[] }).content[0]!.text);
  const w = await call("worker_start", { name: "w1", cwd: root, prompt: "run tests" });
  expect(w.sessionId).toBeTruthy();
  const waited = await call("worker_wait", { names: ["w1"], types: ["permission"], timeoutMs: 5000 });
  const request = waited.events[0];
  await new Promise((r) => setTimeout(r, 100));
  expect(hubPushes).toEqual([]);
  await call("worker_escalate", { name: "w1", id: request.requestId, reason: "network" });
  await vi.waitFor(() => expect(hubPushes.map((p) => p.body)).toEqual([expect.stringContaining("Escalated by coordinator: network")]));
}, 20000);
