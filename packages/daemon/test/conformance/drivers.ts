// One driver per adapter: runs a whole Session on that adapter's Engine, replaying a recorded fixture, and collects the Part events the Session emits.
// The Claude adapter replays an SDK recording (fixture-query.ts); OpenCode 1 and 2 run the fake `opencode` binary of test/fixtures with scripted turns.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Event, SupportTable } from "@claude-ui/protocol";
import type { Engine } from "../../src/engine.ts";
import { CLAUDE_SUPPORT, claudeEngine } from "../../src/claude-engine.ts";
import { createOpenCodeEngine, OPENCODE_SUPPORT } from "../../src/opencode-engine.ts";
import { createOpenCode2Engine, OPENCODE2_SUPPORT } from "../../src/opencode2-engine.ts";
import { createOpenCodeServer } from "../../src/opencode-server.ts";
import { Session } from "../../src/session.ts";
import { fixtureQuery } from "./fixture-query.ts";

export type AdapterName = "claude" | "opencode1" | "opencode2";

/** A running session of one adapter. */
export type Run = {
  engine: Engine;
  session: Session;
  events: Event[];
  /** Sends a prompt and settles when the turn ended (the session is idle again). */
  prompt(text: string): Promise<void>;
  /** Bash mode: runs `command` in the session cwd and settles when it ended. */
  bash(command: string): Promise<void>;
  close(): Promise<void>;
};

/** What a scenario needs from a fixture: one name per adapter; the driver maps it to its own file. */
export type Fixtures = { claude?: string; opencode1?: string; opencode2?: string };

export type Driver = { adapter: AdapterName; label: string; /** The adapter's support table, known before a session opens: it decides which scenarios are skipped. */ support: SupportTable; open(fixtures: Fixtures): Promise<Run> };

const TIMEOUT_MS = 15_000;
const claudeFixture = (name: string) => new URL(`../../../protocol/test/fixtures/${name}.jsonl`, import.meta.url);
const BIN1 = fileURLToPath(new URL("../fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const BIN2 = fileURLToPath(new URL("../fixtures/opencode2/fake-opencode2-bin.mjs", import.meta.url));
const turn1 = (name: string) => fileURLToPath(new URL(`../fixtures/opencode/turn-${name}.json`, import.meta.url));
const turn2 = (name: string) => fileURLToPath(new URL(`../fixtures/opencode2/turn-${name}.json`, import.meta.url));

const stateOf = (events: Event[]) => [...events].reverse().find((e) => e.part.type === "session_state")?.part;

const until = async (what: string, done: () => boolean) => {
  const deadline = Date.now() + TIMEOUT_MS;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen in ${TIMEOUT_MS} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const idle = (events: Event[]) => {
  const s = stateOf(events);
  return s?.type === "session_state" && s.state === "idle";
};

/** A turn ended: the session went busy after `from` events and is idle again. */
const turnEnded = (events: Event[], from: number) => events.slice(from).some((e) => e.part.type === "session_state" && e.part.state === "running") && idle(events);

/** A bash mode command ended: its `bash` part (Claude, OpenCode 2) or Bash tool call (OpenCode 1) is final. Claude runs it with no busy state. */
const commandEnded = (events: Event[], from: number) =>
  events.slice(from).some((e) => (e.part.type === "bash" && e.part.status !== "running") || (e.part.type === "tool_call" && e.part.tool === "Bash" && (e.part.status === "done" || e.part.status === "error"))) && idle(events);

function runOf(engine: Engine, session: Session, cleanup: () => Promise<void>): Run {
  const events: Event[] = [];
  const asked = new Set<string>();
  session.subscribe(0, (e) => {
    events.push(e);
    // A recorded turn that asks for permission (turn-edit) is answered "allow once": the permission scenarios have their own replies.
    const p = e.part;
    if (p.type === "permission_request" && !p.settled && !asked.has(p.requestId)) {
      asked.add(p.requestId);
      queueMicrotask(() => session.respond(p.requestId, { decision: "allow" }));
    }
  });
  return {
    engine,
    session,
    events,
    async prompt(text) {
      const from = events.length;
      session.prompt(text);
      await until("the turn to end", () => turnEnded(events, from));
    },
    async bash(command) {
      const from = events.length;
      session.bash(command);
      await until("the command to end", () => commandEnded(events, from));
    },
    async close() {
      await session.close();
      await cleanup();
    },
  };
}

const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "conformance-")));

const claude: Driver = {
  adapter: "claude",
  label: "Claude",
  support: CLAUDE_SUPPORT,
  async open(f) {
    const cwd = scratch();
    // A scenario without a Claude fixture (bash mode: the daemon runs the shell) still needs a query; the fixture is never replayed because the command makes no turn.
    const query = f.claude ? fixtureQuery(claudeFixture(f.claude)) : fixtureQuery(claudeFixture("two-turn-text"));
    const session = new Session(cwd, { engine: claudeEngine, query: query as never });
    return runOf(claudeEngine, session, async () => rmSync(cwd, { recursive: true, force: true }));
  },
};

function opencode(adapter: "opencode1" | "opencode2"): Driver {
  const v2 = adapter === "opencode2";
  return {
    adapter,
    label: v2 ? "OpenCode 2" : "OpenCode 1",
    support: v2 ? OPENCODE2_SUPPORT : OPENCODE_SUPPORT,
    async open(f) {
      const cwd = scratch();
      const script = (v2 ? f.opencode2 : f.opencode1)?.split(",").filter(Boolean).map(v2 ? turn2 : turn1).join(",") ?? "";
      const env: Record<string, string> = v2 ? { FAKE_OPENCODE2_SCRIPT: script } : { FAKE_OPENCODE_SCRIPT: script };
      const server = createOpenCodeServer({ path: () => "", command: [process.execPath, v2 ? BIN2 : BIN1], env: () => env });
      // A new session as the catalogue makes it: the OpenCode session first (with the rules of its mode), then the Session on its id.
      let engine: Engine;
      let id: string;
      if (v2) {
        const e = createOpenCode2Engine(server);
        const created = await e.createRules("default", cwd);
        const row = await (await server.client()).session.create({ location: { directory: cwd }, permissions: created.rules, ...(created.agent && { agent: created.agent }) });
        e.noteCreated(row.id, created);
        [engine, id] = [e, row.id];
      } else {
        const e = createOpenCodeEngine(server);
        const permission = await e.block("default", cwd);
        const row = await server.request<{ id: string }>("/session", { method: "POST", directory: cwd, timeoutMs: 0, body: { permission } });
        e.noteCreated(row.id, permission);
        [engine, id] = [e, row.id];
      }
      const session = new Session(cwd, { engine, permissionMode: "default" }, { id });
      return runOf(engine, session, async () => {
        await server.close();
        rmSync(cwd, { recursive: true, force: true });
      });
    },
  };
}

export const DRIVERS: Driver[] = [claude, opencode("opencode1"), opencode("opencode2")];
