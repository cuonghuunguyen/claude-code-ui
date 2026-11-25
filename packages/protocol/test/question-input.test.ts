import { describe, expect, it } from "vitest";
import { checkAnswer, isActive, type Question } from "../src/index.ts";

const code = (input: Parameters<typeof checkAnswer>[0], text: string) => checkAnswer(input, text)?.code;

describe("checkAnswer", () => {
  it.each([
    ["date", "2026-12-01", undefined],
    ["date", "2026-02-30", "date"],
    ["date", "12/01/2026", "date"],
    ["date-time", "2026-12-01T10:00:00Z", undefined],
    ["date-time", "2026-12-01T10:00:00.250+01:00", undefined],
    ["date-time", "2026-12-01T10:00:00", "date-time"],
    ["date-time", "2026-13-01T10:00:00Z", "date-time"],
    ["email", "a@b.co", undefined],
    ["email", "a@b", "email"],
    ["email", "a b@c.de", "email"],
    ["uri", "https://example.com/x", undefined],
    ["uri", "example.com", "uri"],
    ["number", "0.5", undefined],
    ["number", "", "number"],
    ["integer", "2.5", "integer"],
  ] as const)("%s %j -> %s", (type, text, expected) => expect(code({ type }, text)).toBe(expected));

  it("range, length by code points and unanchored pattern", () => {
    expect(checkAnswer({ type: "integer", minimum: 1, maximum: 5 }, "9")).toEqual({ code: "maximum", limit: 5 });
    expect(code({ type: "number", minimum: 1 }, "0")).toBe("minimum");
    expect(code({ type: "text", maxLength: 1 }, "😀")).toBeUndefined();
    expect(code({ type: "text", minLength: 3 }, "😀😀")).toBe("minLength");
    expect(code({ type: "text", pattern: "\\d{3}" }, "ab123")).toBeUndefined();
    expect(code({ type: "text", pattern: "^\\d{3}$" }, "ab123")).toBe("pattern");
    expect(code({ type: "text", pattern: "(" }, "anything")).toBeUndefined();
  });
});

describe("isActive", () => {
  const q = (question: string, extra: Partial<Question> = {}): Question => ({ question, header: question, options: [], multiSelect: false, ...extra });
  const yes = [{ label: "Yes", description: "" }, { label: "No", description: "" }];
  const deploy = q("Deploy", { options: yes });
  const where = q("Where", { when: [{ question: "Deploy", op: "eq", value: "Yes" }] });
  const all = [deploy, where];
  it("eq and neq on an answer", () => {
    expect(isActive(where, { Deploy: "Yes" }, all)).toBe(true);
    expect(isActive(where, { Deploy: "No" }, all)).toBe(false);
    expect(isActive({ ...where, when: [{ question: "Deploy", op: "neq", value: "Yes" }] }, { Deploy: "No" }, all)).toBe(true);
    expect(isActive(deploy, {}, all)).toBe(true);
  });
  it("multi-select membership and a chained inactive condition", () => {
    const m = q("M", { multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] });
    const onB = q("OnB", { when: [{ question: "M", op: "eq", value: "B" }] });
    expect(isActive(onB, { M: "A, B" }, [m, onB])).toBe(true);
    expect(isActive(onB, { M: "A" }, [m, onB])).toBe(false);
    const deep = q("Deep", { when: [{ question: "Where", op: "eq", value: "x" }] });
    expect(isActive(deep, { Deploy: "No", Where: "x" }, [deploy, where, deep])).toBe(false);
    expect(isActive(deep, { Deploy: "Yes", Where: "x" }, [deploy, where, deep])).toBe(true);
  });
});
