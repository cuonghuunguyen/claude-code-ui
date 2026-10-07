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
  it("is an OpenCode dock: one question per page with option cards plus a free answer; radios for single select", () => {
    const html = renderToStaticMarkup(<QuestionPanel part={request()} onAnswer={() => {}} onDismiss={() => {}} />);
    for (const t of ["Manager", "1 of 2 questions", "Which package manager?", "Select one answer", "npm", "Default", "pnpm", "Faster", "Type your own answer"]) expect(html).toContain(t);
    expect(html).not.toContain("Which features?");
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain(">Dismiss<");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled[^>]*>Next</);
  });
});

describe("QuestionPanel on a phone", () => {
  it("is bounded by the dynamic viewport and scrolls its options; Dismiss, Back and Next/Submit stay outside the scroller", () => {
    const html = renderToStaticMarkup(<QuestionPanel part={request()} onAnswer={() => {}} onDismiss={() => {}} />);
    expect(html).toMatch(/<form[^>]*max-h-\[60dvh\]/);
    // A <fieldset> is no reliable scroll container (older Safari): the scroller wraps it.
    expect(html).toMatch(/<div class="[^"]*overflow-y-auto[^"]*overscroll-contain[^"]*"><fieldset/);
    expect(html.indexOf("</fieldset>")).toBeLessThan(html.indexOf(">Dismiss<"));
    expect(html.indexOf("</fieldset></div>")).toBeGreaterThan(0);
  });
});

describe("escalation and attribution", () => {
  it("an escalated question shows the coordinator's reason as text, escaped", () => {
    const html = renderToStaticMarkup(<QuestionPanel part={request({ escalated: true, reason: "Scope: <b>x</b>" })} onAnswer={() => {}} />);
    expect(html).toContain("Escalated by coordinator:");
    expect(html).toContain("Scope: &lt;b&gt;x&lt;/b&gt;");
    expect(html.indexOf("question-escalated")).toBeLessThan(html.indexOf("<fieldset"));
    expect(renderToStaticMarkup(<QuestionPanel part={request()} onAnswer={() => {}} />)).not.toContain("question-escalated");
  });

  it("the marker says Answered by coordinator as text for a coordinator's answer, nothing extra for the user's", () => {
    const answers = { "Which package manager?": "pnpm", "Which features?": "bun" };
    const by = renderToStaticMarkup(<QuestionMarker part={request({ settled: true, answers, by: "coordinator" })} />);
    expect(by).toContain("Answered by coordinator");
    expect(by).toContain("Manager: pnpm");
    expect(renderToStaticMarkup(<QuestionMarker part={request({ settled: true, answers })} />)).not.toContain("coordinator");
    expect(renderToStaticMarkup(<QuestionMarker part={request({ by: "coordinator" })} />)).not.toContain("Answered by");
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
