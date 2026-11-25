// The commit message generator's one-shot on OpenCode (GH-984): a temporary, tool-less, deny-all session that is deleted on every end.
import { describe, expect, it } from "vitest";
import { oneShot1 } from "../src/opencode-oneshot.ts";
import { oneShot2, oneShotPoll } from "../src/opencode2-oneshot.ts";

type Call = { path: string; method?: string; body?: any };
const req = (signal = new AbortController().signal) => ({ cwd: "/p", system: "SYS", text: "TEXT", model: "deepseek/flash-1", signal });

function server1(answer: () => Promise<unknown> | unknown) {
  const calls: Call[] = [];
  const request = (async (path: string, r: Call = { path }) => {
    calls.push({ path, method: r.method, body: r.body });
    if (path === "/session" && r.method === "POST") return { id: "ses_1" };
    if (path === "/session/ses_1/message") return answer();
    return {};
  }) as never;
  return { calls, server: { request } };
}

describe("OpenCode 1 one-shot", () => {
  it("creates a deny-all session, prompts without tools on the model with the system text, returns the text parts, deletes the session; the list never sees it afterwards", async () => {
    const t = new Set<string>();
    const seen: boolean[] = [];
    const s = server1(() => (seen.push(t.has("ses_1")), { info: {}, parts: [{ type: "text", text: "feat: " }, { type: "reasoning", text: "x" }, { type: "text", text: "a" }] }));
    expect(await oneShot1(s.server, req(), t)).toBe("feat: a");
    expect(s.calls.map((c) => `${c.method ?? "GET"} ${c.path}`)).toEqual(["POST /session", "POST /session/ses_1/message", "DELETE /session/ses_1"]);
    expect(s.calls[0]!.body).toMatchObject({ permission: [{ permission: "*", pattern: "*", action: "deny" }] });
    expect(s.calls[1]!.body).toEqual({ model: { providerID: "deepseek", modelID: "flash-1" }, system: "SYS", tools: { "*": false }, parts: [{ type: "text", text: "TEXT" }] });
    expect(seen).toEqual([true]);
    expect(t.size).toBe(0);
  });
  it("an OpenCode error in the answer rejects, a failed request rejects; the session is deleted either way", async () => {
    const a = server1(() => ({ info: { error: { name: "ProviderModelNotFoundError" } }, parts: [] }));
    await expect(oneShot1(a.server, req(), new Set())).rejects.toThrow(/not available in OpenCode/);
    expect(a.calls.at(-1)).toMatchObject({ method: "DELETE", path: "/session/ses_1" });
    const b = server1(() => Promise.reject(new Error("boom")));
    await expect(oneShot1(b.server, req(), new Set())).rejects.toThrow("boom");
    expect(b.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });
  it("an abort sends the session's abort and deletes it; a value without provider/ is refused before any request", async () => {
    const ctl = new AbortController();
    const s = server1(() => new Promise((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("aborted")))));
    const p = oneShot1(s.server, req(ctl.signal), new Set());
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await expect(p).rejects.toThrow();
    expect(s.calls.map((c) => `${c.method ?? "GET"} ${c.path}`)).toEqual(["POST /session", "POST /session/ses_1/message", "POST /session/ses_1/abort", "DELETE /session/ses_1"]);
    const none = server1(() => ({}));
    await expect(oneShot1(none.server, { ...req(), model: "flash" }, new Set())).rejects.toThrow(/provider\/model/);
    expect(none.calls).toEqual([]);
  });
});

function client2(messages: () => object[], opts: { onPrompt?: () => void } = {}) {
  const calls: string[] = [];
  const seen: Record<string, any> = {};
  const client = {
    session: {
      create: async (a: any) => (calls.push("create"), (seen.create = a), { id: "ses_2" }),
      prompt: async (a: any) => (calls.push("prompt"), (seen.prompt = a), opts.onPrompt?.()),
      interrupt: async () => void calls.push("interrupt"),
      remove: async () => void calls.push("remove"),
    },
    experimental: { session: { instructions: { entry: { put: async (a: any) => (calls.push("put"), (seen.put = a)) } } } },
    message: { list: async () => ({ data: messages(), cursor: {} }) },
  } as never;
  return { client, calls, seen };
}
const idle = (outcome: string, extra = {}) => ({ id: "m3", type: "idle", outcome, ...extra });
const reply = (text: string) => ({ id: "m2", type: "assistant", content: [{ type: "text", text }] });

describe("OpenCode 2 one-shot", () => {
  it("creates a hidden deny-all session with the system entry, waits for the idle row, returns the reply, removes the session", async () => {
    oneShotPoll.ms = 5;
    let polls = 0;
    const c = client2(() => (++polls < 3 ? [{ id: "m1", type: "user" }] : [{ id: "m1", type: "user" }, reply("fix: y"), idle("succeeded")]));
    expect(await oneShot2(c.client, req())).toBe("fix: y");
    expect(c.calls).toEqual(["create", "put", "prompt", "remove"]);
    expect(c.seen.create).toMatchObject({ location: { directory: "/p" }, model: { providerID: "deepseek", id: "flash-1" }, permissions: [{ action: "*", resource: "*", effect: "deny" }], metadata: { "claude-ui.inlineOf": "commit-message" } });
    expect(c.seen.put).toMatchObject({ sessionID: "ses_2", value: "SYS" });
    expect(c.seen.prompt).toMatchObject({ sessionID: "ses_2", text: "TEXT" });
  });
  it("a failed turn rejects with its error; an abort interrupts and removes the session", async () => {
    oneShotPoll.ms = 5;
    const failed = client2(() => [{ id: "m1", type: "user" }, idle("failed", { error: { message: "no credit" } })]);
    await expect(oneShot2(failed.client, req())).rejects.toThrow();
    expect(failed.calls.at(-1)).toBe("remove");
    const ctl = new AbortController();
    const waiting = client2(() => [{ id: "m1", type: "user" }], { onPrompt: () => setTimeout(() => ctl.abort(), 20) });
    await expect(oneShot2(waiting.client, req(ctl.signal))).rejects.toThrow("cancelled");
    expect(waiting.calls.slice(-2)).toEqual(["interrupt", "remove"]);
  });
});
