// Scenarios of the conformance suite. Each has one engine-neutral reference sequence, written by hand (not taken from any adapter), and the fixture each adapter replays.
import type { Feature } from "@claude-ui/protocol";
import type { AdapterName, Fixtures, Run } from "./drivers.ts";
import type { Pattern, Step } from "./normalize.ts";

export type Variant = { adapters: AdapterName[]; steps: Pattern[] };

export type Scenario = {
  name: string;
  /** The support-table feature the scenario proves; none = every adapter must pass it. */
  feature?: Feature;
  fixtures: Fixtures;
  /** The scenario answers permission requests itself (see OpenOptions). */
  manual?: boolean;
  play(run: Run): Promise<void>;
  /** The reference sequence; a list of variants when adapters legitimately show the same thing in different parts: each adapter may match only the variants that name it. */
  expected: Pattern[] | Variant[];
  /** Step kinds an adapter may add (a model that thinks first). */
  optional?: Step["kind"][];
};

export const SCENARIOS: Scenario[] = [
  {
    name: "plain prompt",
    fixtures: { claude: "two-turn-text", opencode1: "text", opencode2: "rec-plain" },
    play: (run) => run.prompt("hello"),
    expected: [{ kind: "user_text" }, { kind: "assistant_text" }],
    optional: ["thinking", "tool", "tool_result"],
  },
  {
    name: "tool call with result",
    fixtures: { claude: "tools-thinking-denied", opencode1: "edit", opencode2: "edit" },
    play: (run) => run.prompt("change the file"),
    expected: [{ kind: "user_text" }, { kind: "tool", status: "done" }, { kind: "tool_result", error: false }],
    optional: ["thinking", "assistant_text", "tool", "tool_result", "permission"],
  },
  {
    name: "bash mode",
    feature: "shell",
    fixtures: { opencode1: "shell", opencode2: "shell" },
    play: (run) => run.bash("echo e2e-ok"),
    // OpenCode 1 runs the command through its shell route, which records a Bash tool call: the web shows it as a Bash card. Claude and OpenCode 2 emit the `bash` part.
    expected: [
      { adapters: ["claude", "opencode2"], steps: [{ kind: "bash", status: "done", failed: false }] },
      { adapters: ["opencode1"], steps: [{ kind: "tool", tool: "Bash", status: "done" }, { kind: "tool_result", error: false }] },
    ],
  },
  {
    name: "permission request allowed once",
    feature: "permissions",
    manual: true,
    fixtures: { claude: "rec-permission", opencode1: "rec-permission", opencode2: "rec-permission" },
    async play(run) {
      run.start("create the file conformance.txt");
      await run.waitFor("a permission request", (p) => p.type === "permission_request" && !p.settled);
      const ask = run.events.map((e) => e.part).find((p) => p.type === "permission_request")!;
      if (ask.type !== "permission_request" || !run.session.respond(ask.requestId, { decision: "allow" })) throw new Error("the request was not pending");
      await run.settle();
    },
    // Every adapter shows the call first, then the request that asks for it.
    expected: [{ kind: "user_text" }, { kind: "tool", tool: "Bash", status: "done" }, { kind: "permission", tool: "Bash", settled: true, decision: "allow" }, { kind: "tool_result", error: false }, { kind: "assistant_text" }],
    optional: ["thinking"],
  },
  {
    name: "question answered",
    feature: "questions",
    fixtures: { claude: "rec-question", opencode1: "rec-question", opencode2: "rec-question" },
    async play(run) {
      run.start("ask me whether I prefer red or blue");
      await run.waitFor("a question", (p) => p.type === "question" && !p.settled);
      const ask = run.events.map((e) => e.part).find((p) => p.type === "question")!;
      if (ask.type !== "question" || !run.session.answer(ask.requestId, { [ask.questions[0]!.question]: ask.questions[0]!.options[0]!.label })) throw new Error("the question was not pending");
      await run.settle();
    },
    expected: [{ kind: "user_text" }, { kind: "question", fields: 1, settled: true, answered: true }, { kind: "assistant_text" }],
    optional: ["thinking", "tool", "tool_result"],
  },
  {
    name: "interrupt ends the turn",
    feature: "interrupt",
    fixtures: { claude: "rec-interrupt", opencode1: "rec-interrupt", opencode2: "rec-interrupt" },
    async play(run) {
      run.start("count slowly from 1 to 100");
      await run.waitFor("answer text", (p) => p.type === "assistant_text");
      await run.session.interrupt();
      await run.settle();
    },
    expected: [{ kind: "user_text" }, { kind: "assistant_text" }, { kind: "interrupted" }],
    optional: ["thinking"],
  },
];
