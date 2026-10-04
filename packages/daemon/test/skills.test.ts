// "Slash commands" dialog requests (docs/spec.md "Config dialogs"): live or config query, the skill state write and its confirmation.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
const project = realpathSync(mkdtempSync(join(tmpdir(), "skills-")));
const quiet = realpathSync(mkdtempSync(join(tmpdir(), "skills-quiet-")));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";

/** As `get_skills_dialog` answers (snake_case). */
const raw = () => [
  { name: "probe", display_name: "probe", description: "Probe skill", source: "project", tokens: 17, state: "on", advertised: true, handles: {} },
  { name: "ponytail:ponytail", display_name: "ponytail:ponytail", description: "Lazy", source: "plugin", tokens: 281, state: "on", locked_by: "plugin", advertised: true, handles: { aliases: ["ponytail"] } },
  { name: "hidden", display_name: "hidden", description: "Off skill", source: "user", tokens: 40, state: "off", advertised: false, handles: { unqualified_name: "hidden", bare_name_reserved: true } },
];
let skills = raw();
type Call = { call: string; options: Options };
const calls: Call[] = [];
const started: Options[] = [];
const closedQueries: Options[] = [];
/** Reads of the dialog after which the CLI's write shows (1 = the first read); Infinity: never. */
const behavior = { showAfterReads: 1, reads: 0, unsupported: false, reloadFails: false };

function skillsQuery(args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  const options = args.options ?? {};
  started.push(options);
  const q = fakeQuery(args);
  const close = q.close;
  return Object.assign(q, {
    getSkillsDialog: async () => {
      calls.push({ call: "getSkillsDialog", options });
      if (behavior.unsupported) throw new Error("Unsupported control request subtype: get_skills_dialog");
      behavior.reads++;
      return { skills: structuredClone(skills).map((s) => (pendingWrite && behavior.reads >= behavior.showAfterReads && s.name === pendingWrite.name ? { ...s, state: pendingWrite.state } : s)) };
    },
    reloadSkills: async () => {
      calls.push({ call: "reloadSkills", options });
      if (behavior.reloadFails) throw new Error("reload failed");
      return { skills: [] };
    },
    close: () => (closedQueries.push(options), close()),
  });
}

let pendingWrite: { name: string; state: string } | undefined;
const cliCalls: { args: string[]; cwd: string; stdin?: string }[] = [];
const cliResult = { code: 0, stdout: '{"ok":true,"changed":true}', stderr: "" };
const http = createDaemon({
  webRoot,
  roots: [webRoot, project, quiet],
  query: skillsQuery as never,
  token,
  cli: async (args, cwd, stdin) => {
    cliCalls.push({ args, cwd, stdin });
    if (cliResult.code === 0) pendingWrite = JSON.parse(stdin!);
    behavior.reads = 0;
    return { ...cliResult };
  },
  configHoldMs: 300,
  configPollMs: 5,
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { port } = http.address() as AddressInfo;
afterAll(() => void http.close());

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const waitFor = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const t = setInterval(() => {
        const m = inbox.find(pred);
        if (m) clearInterval(t), resolve(m);
      }, 5);
    });
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return (await waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId)) as { type: string; result?: any; code?: string; message?: string };
  };
  return new Promise<{ ws: WebSocket; request: typeof request; inbox: ServerMessage[] }>((resolve) => ws.once("open", () => resolve({ ws, request, inbox })));
}

const reset = () => {
  skills = raw();
  pendingWrite = undefined;
  Object.assign(behavior, { showAfterReads: 1, reads: 0, unsupported: false, reloadFails: false });
  Object.assign(cliResult, { code: 0, stdout: '{"ok":true,"changed":true}', stderr: "" });
};

describe("skills.list", () => {
  it("answers from a live session's query, rows in camelCase, handles as the CLI sent them", async () => {
    reset();
    const c = await client();
    const { result } = await c.request({ type: "session.create", cwd: project });
    const id = result.session.id;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    const r = await c.request({ type: "skills.list", cwd: project, sessionId: id });
    expect(calls.at(-1)).toMatchObject({ call: "getSkillsDialog", options: { sessionId: id } });
    expect(r.result.skills).toEqual([
      { name: "probe", displayName: "probe", description: "Probe skill", source: "project", tokens: 17, state: "on", advertised: true, handles: {} },
      { name: "ponytail:ponytail", displayName: "ponytail:ponytail", description: "Lazy", source: "plugin", tokens: 281, state: "on", lockedBy: "plugin", advertised: true, handles: { aliases: ["ponytail"] } },
      { name: "hidden", displayName: "hidden", description: "Off skill", source: "user", tokens: 40, state: "off", advertised: false, handles: { unqualified_name: "hidden", bare_name_reserved: true } },
    ]);
    c.ws.close();
  });

  it("without a live query uses the project's config query, held then closed", async () => {
    reset();
    const c = await client();
    const before = started.filter((o) => o.cwd === quiet).length;
    await c.request({ type: "skills.list", cwd: quiet });
    await c.request({ type: "skills.list", cwd: quiet, sessionId: "not-a-session" });
    const mine = started.filter((o) => o.cwd === quiet);
    expect(mine.length).toBe(before + 1);
    expect(mine.at(-1)).toMatchObject({ persistSession: false, settings: { disableAllHooks: true } });
    await new Promise((r) => setTimeout(r, 400));
    expect(closedQueries).toContain(mine.at(-1));
    c.ws.close();
  });

  it("a CLI without the control request gives an empty list, and a cwd outside the roots is refused", async () => {
    reset();
    behavior.unsupported = true;
    const c = await client();
    expect((await c.request({ type: "skills.list", cwd: quiet })).result).toEqual({ skills: [] });
    expect(await c.request({ type: "skills.list", cwd: "/etc" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    c.ws.close();
  });
});

describe("skills.setState", () => {
  it("writes the exact JSON to the CLI's stdin, reloads, polls until the row shows it, tells every connection", async () => {
    reset();
    behavior.showAfterReads = 3;
    const a = await client();
    const b = await client();
    const r = await a.request({ type: "skills.setState", cwd: quiet, name: "probe", state: "off", handles: {} });
    expect(cliCalls.at(-1)).toEqual({ cwd: quiet, args: ["edit-skill-overrides", "--json"], stdin: '{"name":"probe","state":"off","handles":{}}' });
    expect(r.result.confirmed).toBe(true);
    expect(r.result.skills.find((s: { name: string }) => s.name === "probe").state).toBe("off");
    expect(calls.slice(-4).map((c) => c.call)).toEqual(["reloadSkills", "getSkillsDialog", "getSkillsDialog", "getSkillsDialog"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(b.inbox).toContainEqual({ type: "config.changed", kind: "skills", cwd: quiet });
    a.ws.close();
    b.ws.close();
  });

  it("confirmed false after 5 reads that never show the new state; the write is still reported", async () => {
    reset();
    behavior.showAfterReads = Infinity;
    const c = await client();
    const before = calls.length;
    const r = await c.request({ type: "skills.setState", cwd: quiet, name: "probe", state: "name-only", handles: {} });
    expect(r.result.confirmed).toBe(false);
    expect(r.result.skills.find((s: { name: string }) => s.name === "probe").state).toBe("on");
    expect(calls.slice(before).filter((x) => x.call === "getSkillsDialog")).toHaveLength(5);
    c.ws.close();
  });

  it("a failing reloadSkills does not fail the saved change", async () => {
    reset();
    behavior.reloadFails = true;
    const c = await client();
    expect((await c.request({ type: "skills.setState", cwd: quiet, name: "probe", state: "off" })).result.confirmed).toBe(true);
    c.ws.close();
  });

  it("reports the CLI's error and refuses a bad name, state or cwd without running it", async () => {
    reset();
    const c = await client();
    const n = cliCalls.length;
    expect(await c.request({ type: "skills.setState", cwd: quiet, name: "", state: "off" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "skills.setState", cwd: quiet, name: "probe", state: "maybe" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "skills.setState", cwd: "/etc", name: "probe", state: "off" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    expect(cliCalls.length).toBe(n);
    Object.assign(cliResult, { code: 1, stdout: "", stderr: "This setting cannot be changed from an editor started inside a Claude Code session.\nmore" });
    expect(await c.request({ type: "skills.setState", cwd: quiet, name: "probe", state: "off" })).toMatchObject({ type: "error", code: "cli_failed", message: "This setting cannot be changed from an editor started inside a Claude Code session." });
    c.ws.close();
  });
});
