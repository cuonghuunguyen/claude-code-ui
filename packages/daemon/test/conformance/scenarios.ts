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
    optional: ["thinking", "assistant_text", "tool", "tool_result"],
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
];
