// Manage Plugins dialog requests (docs/spec.md "Config dialogs: plugins"): CLI argv, list parsing, reload fan-out, restart, config.changed.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PluginsListResult, ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { failureKind, manifestOf } from "../src/plugins.ts";
import { timeoutMessage } from "../src/config.ts";
import { fakeQuery } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
const project = realpathSync(mkdtempSync(join(tmpdir(), "plugins-")));
const pluginsDir = realpathSync(mkdtempSync(join(tmpdir(), "plugin-cache-")));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";

// Installed copies: ponytail declares a server in plugin.json and one in a bare-map .mcp.json; skill-creator has a wrapped .mcp.json.
const write = (path: string, v: unknown) => (mkdirSync(join(path, ".."), { recursive: true }), writeFileSync(path, JSON.stringify(v)));
write(join(pluginsDir, "ponytail/.claude-plugin/plugin.json"), { name: "ponytail", description: "Lazy senior dev", mcpServers: { lazy: { command: "x" } } });
write(join(pluginsDir, "ponytail/.mcp.json"), { docs: { command: "y" } });
write(join(pluginsDir, "skill-creator/.mcp.json"), { mcpServers: { creator: { command: "z" } } });

// Recorded from `claude plugin list --json --available` / `plugin marketplace list --json` (CLI 2.1.285), trimmed.
const fixture = (f: string) => readFileSync(new URL(`fixtures/plugins/${f}`, import.meta.url), "utf8").replaceAll("__PROJECT__", project).replaceAll("__PLUGINS__", pluginsDir);
const LIST = fixture("list-available.json");
const MARKETS = fixture("marketplace-list.json");

const cliCalls: { args: string[]; cwd: string }[] = [];
/** The timeout each CLI call asked for (undefined: the runner's default), parallel to `cliCalls`. */
const timeouts: (number | undefined)[] = [];
/** Answer per first args joined ("plugin list", "plugin update", …); default success with no output. */
const answers = new Map<string, { code: number; stdout: string; stderr: string }>();
const answer = (args: string[]) => {
  if (args.join(" ") === "plugin list --json --available") return { code: 0, stdout: LIST, stderr: "" };
  if (args.join(" ") === "plugin marketplace list --json") return answers.get("plugin marketplace list") ?? { code: 0, stdout: MARKETS, stderr: "" };
  return answers.get(args.slice(0, 2).join(" ")) ?? answers.get(args.slice(0, 3).join(" ")) ?? { code: 0, stdout: "", stderr: "" };
};

const reloads: string[] = [];
const settingsRead = new Set<string>();
/** Session ids whose reloadPlugins() throws. */
const failing = new Set<string>();
const started: Options[] = [];
const closedSessions: string[] = [];
function pluginQuery(args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  const options = args.options ?? {};
  started.push(options);
  const q = fakeQuery(args);
  const id = (options.sessionId ?? options.resume)!;
  const close = q.close;
  return Object.assign(q, {
    getSettings: async () => void settingsRead.add(id),
    reloadPlugins: async () => {
      // The CLI re-read its settings first.
      if (!settingsRead.delete(id)) throw new Error("reloadPlugins before getSettings");
      reloads.push(id);
      if (failing.has(id)) throw new Error("reload failed");
      return { commands: [{ name: "lazy", description: "From the plugin", argumentHint: "" }], agents: [], plugins: [], mcpServers: [], error_count: 1 };
    },
    close: () => (closedSessions.push(id), close()),
  });
}

const http = createDaemon({
  webRoot,
  roots: [webRoot, project],
  query: pluginQuery as never,
  token,
  cli: async (args, cwd, _stdin, timeoutMs) => (cliCalls.push({ args, cwd }), timeouts.push(timeoutMs), { ...answer(args) }),
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
    return (await waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId)) as { type: string; result?: unknown; code?: string; message?: string };
  };
  return new Promise<{ ws: WebSocket; request: typeof request; inbox: ServerMessage[]; waitFor: typeof waitFor }>((resolve) => ws.once("open", () => resolve({ ws, request, inbox, waitFor })));
}

/** A session in `project` with a live query (one prompt answered). */
async function liveSession(c: Awaited<ReturnType<typeof client>>) {
  const { result } = (await c.request({ type: "session.create", cwd: project })) as unknown as { result: { session: { id: string } } };
  const id = result.session.id;
  await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
  await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
  await c.waitFor((m) => m.type === "event" && m.sessionId === id && m.part.type === "turn_result");
  return id;
}

describe("plugins.list", () => {
  it("lists this project's installed plugins with manifest data and the update rule, and available ones not installed", async () => {
    const c = await client();
    const r = (await c.request({ type: "plugins.list", cwd: project })).result as PluginsListResult;
    expect(cliCalls.slice(-2).map((x) => x.args.join(" ")).sort()).toEqual(["plugin list --json --available", "plugin marketplace list --json"]);
    expect(cliCalls.at(-1)!.cwd).toBe(project);
    // The local row of another project is left out.
    expect(r.installed.map((p) => [p.id, p.scope, p.updatable])).toEqual([
      ["mattpocock-skills@claude-plugins-official", "project", true],
      ["ponytail@ponytail", "user", true],
      ["skill-creator@claude-plugins-official", "user", true],
      ["cowork-plugin-management@synced", "synced", false],
    ]);
    expect(r.installed[1]).toMatchObject({ enabled: true, version: "4.9.0", description: "Lazy senior dev", mcpServers: ["lazy", "docs"] });
    expect(r.installed[2]!.mcpServers).toEqual(["creator"]);
    expect(r.installed[0]).toMatchObject({ enabled: false, projectPath: project });
    // mattpocock-skills is installed here, so it is not available.
    expect(r.available.map((a) => a.pluginId)).toEqual(["42crunch-api-security-testing@claude-plugins-official", "adobe-for-creativity@claude-plugins-official", "agent-sdk-dev@claude-plugins-official"]);
    expect(r.available[0]).toMatchObject({ name: "42crunch-api-security-testing", marketplaceName: "claude-plugins-official", official: true, installCount: 3448 });
    expect(r.available[0]!.sourceUrl).toBeUndefined();
    expect(r.available[2]!.sourceUrl).toBe("https://github.com/anthropics/claude-plugins-official/tree/main/plugins/agent-sdk-dev");
    expect(r.marketplaces.map((m) => [m.name, m.source, m.official])).toEqual([
      ["claude-notebook", "github", false],
      ["claude-obsidian-marketplace", "directory", false],
      ["claude-plugins-official", "github", true],
      ["ponytail", "github", false],
    ]);
    expect(r.marketplaces[1]).toMatchObject({ path: "/home/me/marketplace" });
    expect((await c.request({ type: "marketplace.list", cwd: project })).result).toEqual({ marketplaces: r.marketplaces });
    c.ws.close();
  });

  it("redacts the user and password of a marketplace URL before it reaches the browser", async () => {
    const c = await client();
    const marketUrl = "https://octocat:ghp_secret123@git.example.com/org/market.git";
    const markets = JSON.parse(MARKETS);
    markets.push({ name: "private", source: "git", url: marketUrl, installLocation: "/home/me/.claude/plugins/marketplaces/private" });
    answers.set("plugin marketplace list", { code: 0, stdout: JSON.stringify(markets), stderr: "" });
    try {
      for (const msg of [{ type: "plugins.list" }, { type: "marketplace.list" }]) {
        const raw = JSON.stringify((await c.request({ ...msg, cwd: project })).result);
        expect(raw).not.toContain("ghp_secret123");
        expect(raw).not.toContain("octocat");
        expect(raw).toContain("https://git.example.com/org/market.git");
      }
      // A CLI error that quotes the URL is redacted too.
      answers.set("plugin marketplace update", { code: 1, stdout: "", stderr: `✘ Failed to update marketplace: Failed to clone ${marketUrl}` });
      expect(await c.request({ type: "marketplace.update", cwd: project, name: "private" })).toMatchObject({ type: "error", message: "Failed to clone https://git.example.com/org/market.git" });
    } finally {
      answers.clear();
    }
    c.ws.close();
  });

  it("reports the CLI's error and refuses a cwd outside the roots", async () => {
    const c = await client();
    expect(await c.request({ type: "plugins.list", cwd: "/etc" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    answers.set("plugin uninstall", { code: 1, stdout: '{"command":"uninstall","outcome":"failed","message":"Plugin \\"x@y\\" not found in installed plugins","failureCode":"not_installed"}', stderr: '✘ Failed to uninstall plugin "x@y": Plugin "x@y" not found in installed plugins' });
    expect(await c.request({ type: "plugins.uninstall", cwd: project, pluginId: "x@y" })).toMatchObject({ type: "error", message: 'Plugin "x@y" not found in installed plugins' });
    answers.set("plugin marketplace add", { code: 1, stdout: "", stderr: "✘ Failed to add marketplace: Path does not exist: /nope\nmore" });
    expect(await c.request({ type: "marketplace.add", cwd: project, source: "/nope" })).toMatchObject({ type: "error", message: "Path does not exist: /nope" });
    // A second glyph inside the message is dropped too (recorded: `marketplace add "nope:/bad source"`).
    answers.set("plugin marketplace add", { code: 1, stdout: "", stderr: "✘ Failed to add marketplace: ✘ Invalid marketplace source format" });
    expect(await c.request({ type: "marketplace.add", cwd: project, source: "nope:/bad source" })).toMatchObject({ type: "error", message: "Invalid marketplace source format" });
    answers.set("plugin install", { code: 1, stdout: "", stderr: '✘ Failed to install plugin "nope@ponytail": Plugin "nope" not found in marketplace "ponytail"' });
    expect(await c.request({ type: "plugins.install", cwd: project, pluginId: "nope@ponytail", scope: "local" })).toMatchObject({ type: "error", message: 'Plugin "nope" not found in the marketplace.' });
    answers.clear();
    const n = cliCalls.length;
    expect(await c.request({ type: "plugins.install", cwd: project, pluginId: "a@b", scope: "global" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "plugins.uninstall", cwd: project, pluginId: "" })).toMatchObject({ type: "error", code: "bad_request" });
    expect(cliCalls.length).toBe(n);
    c.ws.close();
  });
});

describe("plugin writes", () => {
  it("run the exact argv, reload plugins in every live query (commands part), then tell every connection", async () => {
    const a = await client();
    const b = await client();
    const one = await liveSession(a);
    const two = await liveSession(a);
    const cases: [object, string[]][] = [
      [{ type: "plugins.install", pluginId: "ponytail@ponytail", scope: "local" }, ["plugin", "install", "--scope", "local", "--json", "-y", "--", "ponytail@ponytail"]],
      [{ type: "plugins.uninstall", pluginId: "ponytail@ponytail", scope: "local" }, ["plugin", "uninstall", "--scope", "local", "--json", "-y", "--", "ponytail@ponytail"]],
      [{ type: "plugins.uninstall", pluginId: "notes@synced", scope: "synced" }, ["plugin", "uninstall", "--json", "-y", "--", "notes@synced"]],
      [{ type: "plugins.setEnabled", pluginId: "ponytail@ponytail", enabled: false }, ["plugin", "disable", "--json", "--", "ponytail@ponytail"]],
      [{ type: "plugins.setEnabled", pluginId: "ponytail@ponytail", enabled: true }, ["plugin", "enable", "--json", "--", "ponytail@ponytail"]],
      [{ type: "marketplace.remove", name: "ponytail" }, ["plugin", "marketplace", "remove", "--", "ponytail"]],
    ];
    for (const [msg, argv] of cases) {
      reloads.length = 0;
      b.inbox.length = 0;
      const r = await a.request({ ...msg, cwd: project });
      expect(cliCalls.at(-1)).toEqual({ args: argv, cwd: project });
      expect(reloads.sort()).toEqual([one, two].sort());
      expect(r.result).toEqual({ reload: { reloaded: 2, failed: [], errorCount: 2 } });
      await b.waitFor((m) => m.type === "config.changed");
      // A reload that failed nowhere says so: every client clears the restart banner of sessions that reloaded.
      expect(b.inbox).toContainEqual({ type: "config.changed", kind: "plugins", cwd: project, reloadFailed: [] });
    }
    // The reloaded command list reaches the session as its commands part.
    expect(a.inbox.some((m) => m.type === "event" && m.sessionId === one && m.part.type === "commands" && m.part.commands.some((x) => x.name === "lazy"))).toBe(true);
    // Marketplace add and refresh change no loaded plugin: no reload.
    reloads.length = 0;
    await a.request({ type: "marketplace.add", cwd: project, source: "owner/repo" });
    expect(cliCalls.at(-1)!.args).toEqual(["plugin", "marketplace", "add", "--", "owner/repo"]);
    await a.request({ type: "marketplace.update", cwd: project, name: "ponytail" });
    expect(cliCalls.at(-1)!.args).toEqual(["plugin", "marketplace", "update", "--", "ponytail"]);
    expect(reloads).toEqual([]);
    a.ws.close();
    b.ws.close();
  });

  it("names a session whose reload failed; plugins.restart closes its query and the next prompt resumes it", async () => {
    const a = await client();
    const b = await client();
    const ok = await liveSession(a);
    const bad = await liveSession(a);
    failing.add(bad);
    try {
      const r = await a.request({ type: "plugins.reload", cwd: project });
      expect(r.result).toMatchObject({ failed: [bad] });
      expect(reloads).toEqual(expect.arrayContaining([ok, bad]));
      await b.waitFor((m) => m.type === "config.changed");
      expect(b.inbox).toContainEqual({ type: "config.changed", kind: "plugins", cwd: project, reloadFailed: [bad] });
    } finally {
      failing.delete(bad);
    }
    expect(await a.request({ type: "plugins.restart", cwd: project, sessionId: bad })).toMatchObject({ type: "reply" });
    expect(closedSessions).toContain(bad);
    expect(closedSessions).not.toContain(ok);
    const n = started.length;
    await a.request({ type: "session.prompt", sessionId: bad, text: "second" });
    await new Promise((r) => setTimeout(r, 50));
    expect(started.slice(n)).toEqual([expect.objectContaining({ resume: bad, cwd: project })]);
    expect(await a.request({ type: "plugins.restart", cwd: project, sessionId: "nope" })).toMatchObject({ type: "error", code: "not_found" });
    a.ws.close();
    b.ws.close();
  });
});

describe("manifestOf", () => {
  it("reads MCP server files only inside the install path", () => {
    const outside = join(pluginsDir, "outside.json");
    write(outside, { mcpServers: { leaked: {} } });
    write(join(pluginsDir, "inner/.claude-plugin/plugin.json"), { mcpServers: ["./servers.json", "../outside.json", "/etc/passwd"] });
    write(join(pluginsDir, "inner/servers.json"), { mcpServers: { fine: {} } });
    expect(manifestOf(join(pluginsDir, "inner")).mcpServers).toEqual(["fine"]);
  });
});

describe("CLI timeouts", () => {
  it("gives the commands that fetch from git 5 minutes and the quick ones the default", async () => {
    const c = await client();
    const FIVE_MINUTES = 5 * 60_000;
    const cases: [object, number | undefined][] = [
      [{ type: "plugins.list" }, undefined],
      [{ type: "plugins.setEnabled", pluginId: "a@b", enabled: true }, undefined],
      [{ type: "plugins.install", pluginId: "a@b", scope: "user" }, FIVE_MINUTES],
      [{ type: "plugins.update", pluginId: "a@b", scope: "user" }, FIVE_MINUTES],
      [{ type: "marketplace.add", source: "owner/repo" }, FIVE_MINUTES],
      [{ type: "marketplace.update", name: "ponytail" }, FIVE_MINUTES],
    ];
    for (const [msg, ms] of cases) {
      timeouts.length = 0;
      await c.request({ ...msg, cwd: project });
      expect(timeouts.at(-1), JSON.stringify(msg)).toBe(ms);
    }
    c.ws.close();
  });

  it("words the CLI timeout in minutes or seconds", async () => {
    expect(timeoutMessage(5 * 60_000)).toBe("Claude CLI timed out after 5 min");
    expect(timeoutMessage(30_000)).toBe("Claude CLI timed out after 30 s");
  });
});

describe("plugins.update", () => {
  it("runs update with the scope; a changed plugin reloads, one already at the latest version does not", async () => {
    const c = await client();
    const id = await liveSession(c);
    reloads.length = 0;
    answers.set("plugin update", { code: 0, stdout: '{"command":"update","outcome":"ok","plugin":"ponytail@ponytail","message":"Plugin \\"ponytail\\" updated from 4.8.0 to 4.9.0 for scope local. Restart to apply changes."}', stderr: "" });
    const r = await c.request({ type: "plugins.update", cwd: project, pluginId: "ponytail@ponytail", scope: "local" });
    expect(cliCalls.at(-1)!.args).toEqual(["plugin", "update", "--scope", "local", "--json", "-y", "--", "ponytail@ponytail"]);
    expect(r.result).toMatchObject({ outcome: "ok", reload: { failed: [] } });
    expect(reloads).toContain(id);
    reloads.length = 0;
    // Recorded from CLI 2.1.285.
    answers.set("plugin update", { code: 0, stdout: '{"command":"update","outcome":"ok","plugin":"ponytail@ponytail","pluginId":"ponytail@ponytail","scope":"local","message":"ponytail is already at the latest version (4.10.3).","updateOutcome":"up_to_date","oldVersion":"4.10.3","newVersion":"4.10.3"}\n', stderr: "" });
    expect((await c.request({ type: "plugins.update", cwd: project, pluginId: "ponytail@ponytail", scope: "user" })).result).toEqual({ outcome: "ok", message: "ponytail is already at the latest version (4.10.3)." });
    expect(reloads).toEqual([]);
    answers.clear();
    c.ws.close();
  });

  it("replies a failure kind from the CLI's failureCode or message", async () => {
    const c = await client();
    answers.set("plugin update", { code: 1, stdout: '{"command":"update","outcome":"failed","plugin":"nope@ponytail","message":"Plugin \\"nope\\" not found","failureCode":"not_found"}', stderr: '✘ Failed to update plugin "nope@ponytail": Plugin "nope" not found' });
    expect((await c.request({ type: "plugins.update", cwd: project, pluginId: "nope@ponytail", scope: "local" })).result).toEqual({ outcome: "failed", kind: "not_found", message: 'Plugin "nope" not found' });
    answers.set("plugin update", { code: 1, stdout: "", stderr: '✘ Failed to update plugin "x@y": Failed to clone repository: timeout' });
    expect((await c.request({ type: "plugins.update", cwd: project, pluginId: "x@y", scope: "user" })).result).toEqual({ outcome: "failed", kind: "network", message: "Failed to clone repository: timeout" });
    answers.clear();
    expect(await c.request({ type: "plugins.update", cwd: project, pluginId: "x@y", scope: "synced" })).toMatchObject({ type: "error", code: "bad_request" });
    c.ws.close();
  });

  it("maps messages like the extension", () => {
    expect(failureKind('Plugin "x" is blocked by your organization\'s policy')).toBe("policy");
    expect(failureKind("x is disabled, so the command that installs it was not run.")).toBe("disabled");
    expect(failureKind("x is installed by running a command on this machine (`npm i`) that has not been reviewed yet, so it was not run.")).toBe("needs_consent");
    expect(failureKind("anything", "command_source_refused")).toBe("needs_consent");
    expect(failureKind('Plugin "x" is not installed at scope local')).toBe("not_installed");
    expect(failureKind("getaddrinfo ENOTFOUND github.com")).toBe("network");
    expect(failureKind("boom")).toBe("other");
  });
});
