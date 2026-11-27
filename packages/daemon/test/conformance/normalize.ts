// Part events -> an engine-neutral structure. Kept: the kind of each part, a tool's name and final status, a result's error flag, a bash command's final status,
// a permission request's tool and decision, a question's field count and whether it was answered, the interrupt marker.
// Dropped: ids, timestamps, text, input, output, usage, and every part that is session bookkeeping (state, model, commands...).
import type { Event, Part } from "@claude-ui/protocol";

export type Step =
  | { kind: "user_text" }
  | { kind: "assistant_text" }
  | { kind: "thinking" }
  | { kind: "tool"; tool: string; status: string }
  | { kind: "tool_result"; error: boolean }
  | { kind: "bash"; status: string; failed: boolean }
  | { kind: "permission"; tool: string; settled: boolean; decision?: string }
  | { kind: "question"; fields: number; settled: boolean; answered: boolean }
  | { kind: "interrupted" };

const stepOf = (p: Part): Step | undefined => {
  switch (p.type) {
    case "user_text":
    case "assistant_text":
    case "thinking":
      return { kind: p.type };
    case "tool_call":
      return { kind: "tool", tool: p.tool, status: p.status };
    case "tool_result":
      return { kind: "tool_result", error: p.isError };
    case "bash":
      return { kind: "bash", status: p.status, failed: (p.exitCode ?? 0) !== 0 };
    case "permission_request":
      return { kind: "permission", tool: p.tool, settled: p.settled, ...(p.decision && { decision: p.decision }) };
    case "question":
      return { kind: "question", fields: p.questions.length, settled: p.settled, answered: !!p.answers };
    case "turn_interrupted":
      return { kind: "interrupted" };
    default:
      return undefined;
  }
};

/** The last state of each part, in order of its first appearance. */
export function normalize(events: Event[]): Step[] {
  const order: string[] = [];
  const last = new Map<string, Part>();
  for (const e of events) {
    const p = e.part;
    if (!stepOf(p)) continue;
    const key = `${p.type}:${p.id}`;
    if (!last.has(key)) order.push(key);
    last.set(key, p);
  }
  return order.map((k) => stepOf(last.get(k)!)!);
}

/** A step of a reference sequence: a field left out matches any value. */
export type Pattern = { kind: Step["kind"]; tool?: string; status?: string; error?: boolean; failed?: boolean; settled?: boolean; decision?: string; fields?: number; answered?: boolean };

const matches = (a: Step, p: Pattern) => Object.entries(p).every(([k, v]) => (a as Record<string, unknown>)[k] === v);

/**
 * `expected` is the reference sequence of a scenario: every pattern must match a step of `actual`, in order. `actual` may hold more steps of the kinds in `optional`
 * (a model that thinks first); any other extra step is a difference. Returns the first difference, or undefined.
 */
export function compare(actual: Step[], expected: Pattern[], optional: Step["kind"][] = []): string | undefined {
  let i = 0;
  for (const a of actual) {
    if (i < expected.length && matches(a, expected[i]!)) i++;
    else if (!optional.includes(a.kind)) return `unexpected step ${JSON.stringify(a)} before expected step ${i} ${JSON.stringify(expected[i])}`;
  }
  return i < expected.length ? `missing expected step ${i} ${JSON.stringify(expected[i])}` : undefined;
}
