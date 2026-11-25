// Typed answers of a question (OpenCode 2 form fields): one set of rules for the web (before Next/Submit) and the daemon (before the reply).
import type { Question, QuestionInput } from "./parts.ts";

export type InputError = { code: "number" | "integer" | "minimum" | "maximum" | "minLength" | "maxLength" | "pattern" | "date" | "date-time" | "email" | "uri"; limit?: number | string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

/** The first rule `text` breaks, undefined when it passes. `text` is not trimmed or empty-checked here: an empty optional answer is the caller's case. */
export function checkAnswer(input: QuestionInput, text: string): InputError | undefined {
  switch (input.type) {
    case "number":
    case "integer": {
      const n = text.trim() === "" ? NaN : Number(text);
      if (!Number.isFinite(n) || (input.type === "integer" && !Number.isInteger(n))) return { code: input.type };
      if (input.minimum !== undefined && n < input.minimum) return { code: "minimum", limit: input.minimum };
      if (input.maximum !== undefined && n > input.maximum) return { code: "maximum", limit: input.maximum };
      return;
    }
    case "date":
      return isDate(text) ? undefined : { code: "date" };
    case "date-time":
      return DATE_TIME.test(text) && isDate(text.slice(0, 10)) && !Number.isNaN(Date.parse(text)) ? undefined : { code: "date-time" };
    case "email":
      return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text) ? undefined : { code: "email" };
    case "uri": {
      try {
        return new URL(text).protocol ? undefined : { code: "uri" };
      } catch {
        return { code: "uri" };
      }
    }
    case "text": {
      const length = [...text].length;
      if (input.minLength !== undefined && length < input.minLength) return { code: "minLength", limit: input.minLength };
      if (input.maxLength !== undefined && length > input.maxLength) return { code: "maxLength", limit: input.maxLength };
      if (input.pattern !== undefined) {
        let re: RegExp | undefined;
        try {
          re = new RegExp(input.pattern, "u");
        } catch {
          // OpenCode decides on a pattern this runtime cannot read.
        }
        if (re && !re.test(text)) return { code: "pattern", limit: input.pattern };
      }
      return;
    }
  }
}

/** Whether `q` is shown: every condition of `q.when` holds on `answers` (by question text). A condition on an inactive question fails. */
export function isActive(q: Question, answers: Record<string, string>, questions: Question[], seen: Set<string> = new Set()): boolean {
  if (!q.when?.length) return true;
  if (seen.has(q.question)) return false;
  const path = new Set(seen).add(q.question);
  return q.when.every((w) => {
    const target = questions.find((x) => x.question === w.question);
    if (!target || !isActive(target, answers, questions, path)) return false;
    const text = answers[w.question] ?? "";
    const holds = text === w.value || (target.multiSelect && text.split(", ").includes(w.value));
    return holds === (w.op !== "neq");
  });
}
