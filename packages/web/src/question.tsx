// Question panel (replaces the prompt box) and its timeline marker (docs/spec.md "Questions").
import { useState, type FormEvent } from "react";
import type { Question } from "@claude-ui/protocol";
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { QuestionRequest } from "./store.ts";

/** `other`: the Other free text, undefined while Other is not chosen. */
export type Choice = { chosen: string[]; other?: string };

/** The answer Claude gets: chosen labels in option order, then the Other text, joined with ", " (the SDK's multi-select format). */
export function answerText(q: Question, { chosen, other }: Choice): string {
  const labels = q.options.map((o) => o.label).filter((l) => chosen.includes(l));
  const text = other?.trim();
  return [...labels, ...(text ? [text] : [])].join(", ");
}

export function QuestionPanel({ part, onAnswer }: { part: QuestionRequest; onAnswer: (answers: Record<string, string>) => void }) {
  const [choices, setChoices] = useState<Choice[]>(() => part.questions.map(() => ({ chosen: [] })));
  const answers = part.questions.map((q, i) => answerText(q, choices[i]!));
  const set = (i: number, c: Choice) => setChoices((all) => all.map((x, j) => (j === i ? c : x)));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onAnswer(Object.fromEntries(part.questions.map((q, i) => [q.question, answers[i]!])));
  };
  return (
    <form onSubmit={submit} className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-lg border border-info/50 p-3 text-sm" data-testid="question-panel" aria-label="Question">
      {part.questions.map((q, i) => {
        const c = choices[i]!;
        const type = q.multiSelect ? "checkbox" : "radio";
        const toggle = (label: string) => set(i, q.multiSelect ? { ...c, chosen: c.chosen.includes(label) ? c.chosen.filter((l) => l !== label) : [...c.chosen, label] } : { chosen: [label] });
        const preview = q.options.find((o) => o.preview && c.chosen.includes(o.label))?.preview;
        return (
          <fieldset key={q.question} className="flex flex-col gap-1">
            <legend className="mb-1">
              <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">{q.header}</span>
              <span className="font-medium">{q.question}</span>
            </legend>
            {q.options.map((o) => (
              <label key={o.label} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 hover:bg-muted">
                <input type={type} name={q.question} className="mt-1" checked={c.chosen.includes(o.label)} onChange={() => toggle(o.label)} />
                <span>
                  {o.label}
                  <span className="block text-muted-foreground text-xs">{o.description}</span>
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
              <input
                type={type}
                name={q.question}
                checked={c.other !== undefined}
                onChange={() => set(i, q.multiSelect ? { ...c, other: c.other === undefined ? "" : undefined } : { chosen: [], other: c.other ?? "" })}
              />
              <span>Other</span>
              <input
                className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1"
                aria-label={`Other answer to: ${q.question}`}
                placeholder="Type your own answer"
                value={c.other ?? ""}
                // Typing chooses Other; for a single-select question it replaces the chosen option.
                onChange={(e) => set(i, q.multiSelect ? { ...c, other: e.target.value } : { chosen: [], other: e.target.value })}
              />
            </label>
            {preview && <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">{preview}</pre>}
          </fieldset>
        );
      })}
      <Button type="submit" className="self-end" disabled={answers.some((a) => !a)}>
        Submit
      </Button>
    </form>
  );
}

export function QuestionMarker({ part }: { part: QuestionRequest }) {
  const [label, Icon, className] = !part.settled
    ? ["Waiting for an answer", CircleHelpIcon, "text-info"]
    : part.answers
      ? [part.questions.map((q) => `${q.header}: ${part.answers![q.question] ?? ""}`).join(" · "), CircleCheckIcon, "text-success"]
      : ["Cancelled", CircleXIcon, "text-muted-foreground"];
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs" data-testid="question-marker" data-settled={part.settled}>
      <Icon className={`size-4 shrink-0 ${className}`} />
      <span className="truncate">Question · {label}</span>
    </div>
  );
}
