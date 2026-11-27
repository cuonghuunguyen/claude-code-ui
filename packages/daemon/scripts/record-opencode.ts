// Records the event stream of a real OpenCode server running one scenario, into <out>/<scenario>.events.jsonl (cut it with scripts/cut-turn.ts).
// Usage: npm run record-opencode -w @claude-ui/daemon -- --v1|--v2 --bin <opencode binary> --scenario plain|permission|question|interrupt --out <dir>
//          [--model deepseek/deepseek-flash] [--auth <auth.json>]
// The server is started by the daemon's own code (opencode-server.ts), in a scratch folder with its own XDG dirs. The OpenCode login is not copied: <out>/data/opencode/auth.json
// is a symlink to the original (--auth, default ~/.local/share/opencode/auth.json). Sessions are created and answered the way the engines do (rules of the "default" mode).
// Log lines: {t, kind: "event", directory, type, properties} for every payload of the stream, {t, kind: "action", action, ...} for what the recorder did.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createOpenCodeEngine } from "../src/opencode-engine.ts";
import { createOpenCode2Engine } from "../src/opencode2-engine.ts";
import { createOpenCodeServer } from "../src/opencode-server.ts";

export type Entry = { t: number; kind: "event"; directory?: string; type: string; properties: Record<string, any> } | { t: number; kind: "action"; action: string; [k: string]: unknown };

const SCENARIOS = {
  plain: { prompt: "Reply with one short sentence about rivers. Do not use tools." },
  permission: { prompt: "Run the shell command `touch conformance.txt` with the bash tool, then confirm in one short sentence. Use no other tool." },
  question: { prompt: "Use the question tool to ask me whether I prefer red or blue (those two options). After my answer reply with one short sentence. Use no other tool." },
  interrupt: { prompt: "Write a 600 word essay about rivers. Do not use tools." },
} as const;
type Name = keyof typeof SCENARIOS;

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const major = argv.includes("--v2") ? 2 : argv.includes("--v1") ? 1 : undefined;
const bin = arg("--bin");
const scenarioName = arg("--scenario") as Name | undefined;
const outDir = arg("--out");
const modelArg = arg("--model") ?? "deepseek/deepseek-flash";
const auth = resolve(arg("--auth") ?? join(homedir(), ".local/share/opencode/auth.json"));
if (!major || !bin || !scenarioName || !SCENARIOS[scenarioName] || !outDir) (console.error("usage: record-opencode --v1|--v2 --bin <opencode> --scenario plain|permission|question|interrupt --out <dir> [--model p/m] [--auth file]"), process.exit(2));
// ADR 0002 and the owner's rule: the paid DeepSeek model, never a free one.
if (modelArg !== "deepseek/deepseek-flash") (console.error(`refusing the model ${modelArg}: recordings use deepseek/deepseek-flash (DeepSeek V4.1 Flash)`), process.exit(2));
if (!existsSync(auth)) (console.error(`no OpenCode login at ${auth}`), process.exit(2));
const [providerID, ...rest] = modelArg.split("/");
const modelID = rest.join("/");
const scenario = SCENARIOS[scenarioName];

const out = resolve(outDir);
mkdirSync(join(out, "data/opencode"), { recursive: true });
for (const d of ["config", "cache", "state"]) mkdirSync(join(out, d), { recursive: true });
rmSync(join(out, "data/opencode/auth.json"), { force: true });
symlinkSync(auth, join(out, "data/opencode/auth.json"));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "record-opencode-")));
const file = join(out, `${scenarioName}.events.jsonl`);
writeFileSync(file, "");
const t0 = Date.now();
const entries: Entry[] = [];
const log = (e: { kind: "event"; directory?: string; type: string; properties: Record<string, any> } | { kind: "action"; action: string; [k: string]: unknown }) => {
  const entry = { t: Date.now() - t0, ...e } as Entry;
  entries.push(entry);
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
};
const action = (name: string, extra: Record<string, unknown> = {}) => log({ kind: "action", action: name, ...extra });
action("start", { cwd, version: major, model: modelArg });

const env: NodeJS.ProcessEnv = {
  XDG_DATA_HOME: join(out, "data"),
  XDG_CONFIG_HOME: join(out, "config"),
  XDG_CACHE_HOME: join(out, "cache"),
  XDG_STATE_HOME: join(out, "state"),
  // Nothing of the user's config (plugins, MCP servers) may shape a recording.
  OPENCODE_CONFIG: join(out, "config/opencode.json"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
};
writeFileSync(env.OPENCODE_CONFIG!, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: modelArg, autoupdate: false }));
// Nothing of the shell may shape a recording: no API keys, no OPENCODE_* settings of the user (the recorder sets its own below).
for (const v of Object.keys(process.env)) if (v === "ANTHROPIC_API_KEY" || v === "ANTHROPIC_AUTH_TOKEN" || (v.startsWith("OPENCODE_") && !(v in env))) delete process.env[v];

const server = createOpenCodeServer({ path: () => resolve(bin!), env: () => env });
const wait = async (what: string, done: () => boolean, ms = 180_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`${what} did not happen in ${ms / 1000} s`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const seen = (type: string, from = 0) => entries.slice(from).find((e) => e.kind === "event" && e.type === type) as Extract<Entry, { kind: "event" }> | undefined;

server.events(
  {
    event: (directory, p) => (p.type.startsWith("server.") || p.type === "sync" ? undefined : log({ kind: "event", directory, type: p.type, properties: p.properties })),
    resync: () => action("resync"),
  },
  major as 1 | 2,
);

try {
  let id: string;
  let v1: ReturnType<typeof createOpenCodeEngine> | undefined;
  if (major === 2) {
    const engine = createOpenCode2Engine(server);
    const created = await engine.createRules("default", cwd);
    const row = await (await server.client()).session.create({ location: { directory: cwd }, permissions: created.rules, ...(created.agent && { agent: created.agent }) });
    id = row.id;
  } else {
    v1 = createOpenCodeEngine(server);
    const permission = await v1.block("default", cwd);
    id = (await server.request<{ id: string }>("/session", { method: "POST", directory: cwd, timeoutMs: 0, body: { permission } })).id;
  }
  // Let the stream connect before the prompt.
  await new Promise((r) => setTimeout(r, 1500));
  action("prompt", { sessionID: id, text: scenario.prompt, model: modelArg });
  const from = entries.length;
  const messageID = `msg_${Date.now().toString(16).padStart(12, "0")}rec000000000000`.slice(0, 30);
  if (major === 2) {
    await (await server.client()).session.prompt({ sessionID: id, id: messageID, text: scenario.prompt });
  } else {
    await server.request(`/session/${id}/prompt_async`, {
      method: "POST",
      directory: cwd,
      timeoutMs: 0,
      body: { messageID, parts: [{ id: `prt_${messageID.slice(4)}`, type: "text", text: scenario.prompt }], agent: "build", model: { providerID, modelID } },
    });
  }
  const ended = () => (major === 2 ? entries.slice(from).some((e) => e.kind === "event" && /^session\.execution\.(succeeded|interrupted|failed)$/.test(e.type)) : entries.slice(from).some((e) => e.kind === "event" && (e.type === "session.idle" || (e.type === "session.status" && e.properties.status?.type === "idle"))));

  if (scenarioName === "permission") {
    await wait("a permission request", () => ended() || !!seen("permission.asked", from));
    const ask = seen("permission.asked", from);
    if (!ask) throw new Error("the turn ended without a permission request: the model did not call a tool that asks");
    const requestID = (ask.properties.id ?? ask.properties.requestID) as string;
    action("permission.reply", { requestID, reply: "once" });
    if (major === 2) await (await server.client()).permission.reply({ sessionID: id, requestID, decision: "once" });
    else await server.request(`/permission/${requestID}/reply`, { method: "POST", directory: cwd, body: { reply: "once" } });
  } else if (scenarioName === "question") {
    const asked = () => seen(major === 2 ? "form.created" : "question.asked", from);
    await wait("a question", () => ended() || !!asked());
    const ask = asked();
    if (!ask) throw new Error("the turn ended without a question: the model did not call the question tool");
    if (major === 2) {
      const form = ask.properties.form as { id: string; sessionID: string; fields: { key: string; type: string; options?: { value: unknown }[] }[] };
      const answer = Object.fromEntries(form.fields.map((f) => [f.key, f.type === "multiselect" ? [f.options![0]!.value] : f.options![0]!.value]));
      action("form.reply", { formID: form.id, answer });
      await (await server.client()).session.form.reply({ sessionID: id, formID: form.id, answer: answer as never });
    } else {
      const requestID = ask.properties.id as string;
      const questions = ask.properties.questions as { options: { label: string }[] }[];
      const answers = questions.map((q) => [q.options[0]!.label]);
      action("question.reply", { requestID, answers });
      await server.request(`/question/${requestID}/reply`, { method: "POST", directory: cwd, body: { answers } });
    }
  } else if (scenarioName === "interrupt") {
    // Stop after the first streamed words of the answer.
    // Text of the answer only: not the reasoning, not the echo of the user's own message (OpenCode 1 streams all of them as `message.part.delta`).
    const textParts = () => new Set(entries.slice(from).flatMap((e) => (e.kind === "event" && e.type === "message.part.updated" && e.properties.part?.type === "text" && e.properties.part.messageID !== messageID ? [e.properties.part.id as string] : [])));
    const delta = () => {
      const parts = textParts();
      return entries.slice(from).filter((e) => e.kind === "event" && (e.type === "session.text.delta" || (e.type === "message.part.delta" && parts.has(e.properties.partID)))).length;
    };
    await wait("streamed text", () => ended() || delta() >= 3);
    if (ended()) throw new Error("the turn ended before the interrupt");
    action("interrupt");
    if (major === 2) await (await server.client()).session.interrupt({ sessionID: id });
    else await server.request(`/session/${id}/abort`, { method: "POST", directory: cwd, timeoutMs: 0 });
  }
  await wait("the turn to end", ended);
  // A few late events (session.idle after the status, the last message update).
  await new Promise((r) => setTimeout(r, 1500));
  console.error(`recorded ${entries.length} lines into ${file}`);
} finally {
  await server.close?.();
  rmSync(cwd, { recursive: true, force: true });
}
