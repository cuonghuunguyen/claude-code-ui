// @vitest-environment jsdom
import type { Question } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionPanel } from "./question.tsx";
import type { QuestionRequest } from "./store.ts";

const text = (question: string, extra: Partial<Question> = {}): Question => ({ question, header: question, options: [], multiSelect: false, ...extra });
const yesNo = [{ label: "Yes", description: "" }, { label: "No", description: "" }];
const part = (questions: Question[]): QuestionRequest => ({ type: "question", id: "q1", requestId: "q1", toolUseId: "t1", questions, settled: false });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const mount = (questions: Question[]) => {
  const onAnswer = vi.fn();
  act(() => root.render(<QuestionPanel part={part(questions)} onAnswer={onAnswer} />));
  return onAnswer;
};
const input = () => el.querySelector<HTMLInputElement>("input:not([type=radio]):not([type=checkbox])")!;
const type = (node: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
const blur = (node: HTMLElement) => act(() => void node.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
const button = (label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = (node: HTMLElement) => act(() => void node.click());
const submit = () => act(() => void el.querySelector("form")!.requestSubmit());

it("a date question is a date input and Submit waits for a valid date", () => {
  const onAnswer = mount([text("Due", { input: { type: "date" } })]);
  expect(input().type).toBe("date");
  expect(button("Submit")!.disabled).toBe(true);
  type(input(), "2026-12-01");
  expect(button("Submit")!.disabled).toBe(false);
  submit();
  expect(onAnswer).toHaveBeenCalledWith({ Due: "2026-12-01" }, { Due: ["2026-12-01"] });
});

it("a pattern error shows after blur, with the field marked invalid, and Submit stays disabled", () => {
  mount([text("Code", { input: { type: "text", pattern: "^[A-Z]{3}$" } })]);
  type(input(), "ab");
  expect(el.querySelector("[role=alert]")).toBeNull();
  blur(input());
  expect(el.querySelector("[role=alert]")!.textContent).toBe("Does not match the required format");
  expect(input().getAttribute("aria-invalid")).toBe("true");
  expect(button("Submit")!.disabled).toBe(true);
  type(input(), "ABC");
  expect(button("Submit")!.disabled).toBe(false);
});

it("a conditional question is no page and is not sent while its condition fails; it becomes a page when the answer matches", () => {
  const onAnswer = mount([text("Deploy", { options: yesNo }), text("Where", { input: { type: "text" }, when: [{ question: "Deploy", op: "eq", value: "Yes" }] })]);
  expect(el.textContent).toContain("1 of 1 questions");
  click(el.querySelector<HTMLInputElement>('input[type=radio]')!);
  expect(el.textContent).toContain("1 of 2 questions");
  expect(button("Next")).toBeDefined();
  click(el.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]!);
  expect(el.textContent).toContain("1 of 1 questions");
  expect(button("Submit")!.disabled).toBe(false);
  submit();
  expect(onAnswer).toHaveBeenCalledWith({ Deploy: "No" }, { Deploy: ["No"] });
});

it("an optional question submits empty, without its key", () => {
  const onAnswer = mount([text("Note", { optional: true, input: { type: "text" } }), text("Name", { input: { type: "text" } })]);
  expect(el.textContent).toContain("Optional");
  click(button("Next")!);
  type(input(), "Ada");
  submit();
  expect(onAnswer).toHaveBeenCalledWith({ Name: "Ada" }, { Name: ["Ada"] });
});

it("a date-time is sent as RFC 3339 UTC", () => {
  const onAnswer = mount([text("At", { input: { type: "date-time" } })]);
  expect(input().type).toBe("datetime-local");
  type(input(), "2026-12-01T10:00:00");
  submit();
  const sent = onAnswer.mock.calls[0]![0].At as string;
  expect(sent).toBe(new Date("2026-12-01T10:00:00").toISOString().replace(".000Z", "Z"));
  expect(sent).toMatch(/Z$/);
});

it("a question that depends on a later one is not the first page: the panel opens on the controlling question", () => {
  const onAnswer = mount([text("Why", { input: { type: "text" }, when: [{ question: "Kind", op: "eq", value: "Other" }] }), text("Kind", { options: [{ label: "Other", description: "" }, { label: "Bug", description: "" }] })]);
  expect(el.textContent).toContain("Kind");
  expect(el.textContent).toContain("1 of 1 questions");
  click(el.querySelector<HTMLInputElement>("input[type=radio]")!);
  expect(el.textContent).toContain("1 of 2 questions");
});

it("a free text next to options is checked with the field's rules, an option is not", () => {
  mount([text("Due", { input: { type: "date" }, options: [{ label: "Today", description: "" }] })]);
  click(el.querySelector<HTMLInputElement>("input[type=radio]")!);
  expect(button("Submit")!.disabled).toBe(false);
  type(el.querySelector<HTMLInputElement>("input:not([type=radio])")!, "soon");
  expect(button("Submit")!.disabled).toBe(true);
});
