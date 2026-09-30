import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Event, Part, Question } from "@claude-ui/protocol";
import { answerText, QuestionMarker, QuestionPanel } from "./question.tsx";
import { applyEvent, emptySession, pendingQuestion, type QuestionRequest } from "./store.ts";

const manager: Question = {
  question: "Which package manager?",
  header: "Manager",
  options: [
    { label: "npm", description: "Default" },
    { label: "pnpm", description: "Faster" },
  ],
  multiSelect: false,
};
const features: Question = { ...manager, question: "Which features?", header: "Features", multiSelect: true };
const request = (over: Partial<QuestionRequest> = {}): QuestionRequest => ({
  type: "question",
  id: "q1",
  requestId: "q1",
  toolUseId: "t1",
  questions: [manager, features],
  settled: false,
  ...over,
});

describe("answerText", () => {
  it("is the chosen labels in option order, with the Other text last, joined with ', '", () => {
    expect(answerText(manager, { chosen: ["pnpm"], other: undefined })).toBe("pnpm");
    expect(answerText(manager, { chosen: [], other: "  yarn " })).toBe("yarn");
    expect(answerText(features, { chosen: ["pnpm", "npm"], other: "bun" })).toBe("npm, pnpm, bun");
  });

  it("is empty when nothing is chosen or Other is blank", () => {
    expect(answerText(manager, { chosen: [], other: undefined })).toBe("");
    expect(answerText(manager, { chosen: [], other: " " })).toBe("");
  });
});

describe("QuestionPanel", () => {
  it("shows each question with its choices plus Other free text; radios for single, checkboxes for multi select", () => {
    const html = renderToStaticMarkup(<QuestionPanel part={request()} onAnswer={() => {}} />);
    for (const t of ["Manager", "Which package manager?", "Features", "Which features?", "npm", "Default", "pnpm", "Faster"]) expect(html).toContain(t);
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html.match(/>Other</g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});

describe("QuestionMarker", () => {
  it.each([
    [request(), "Waiting for an answer"],
    [request({ settled: true, answers: { "Which package manager?": "pnpm", "Which features?": "npm, bun" } }), "Manager: pnpm · Features: npm, bun"],
    [request({ settled: true }), "Cancelled"],
  ])("shows the question state in the timeline", (part, label) => {
    expect(renderToStaticMarkup(<QuestionMarker part={part} />)).toContain(label);
  });
});

describe("pendingQuestion", () => {
  it("is the oldest unsettled question, cleared by its settlement event", () => {
    const ev = (seq: number, part: Part): Event => ({ type: "event", sessionId: "s", seq, part });
    let s = applyEvent(emptySession(), ev(1, request()));
    expect(pendingQuestion(s)?.id).toBe("q1");
    s = applyEvent(s, ev(2, request({ settled: true, answers: {} })));
    expect(pendingQuestion(s)).toBeUndefined();
  });
});
