// Question panel (replaces the prompt box) and its timeline marker (docs/spec.md "Questions").
import { useState, type FormEvent } from "react";
import type { Question } from "@claude-ui/protocol";
import { CircleCheckIcon, CircleHelpIcon, CircleXIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DOCK, TRAY } from "./permission.tsx";
import type { QuestionRequest } from "./store.ts";

/** `other`: the Other free text, undefined while Other is not chosen. */
export type Choice = { chosen: string[]; other?: string };

/** The answer Claude gets: chosen labels in option order, then the Other text, joined with ", " (the SDK's multi-select format). */
export function answerText(q: Question, { chosen, other }: Choice): string {
  const labels = q.options.map((o) => o.label).filter((l) => chosen.includes(l));
  const text = other?.trim();
  return [...labels, ...(text ? [text] : [])].join(", ");
}

/** OpenCode question dock: one question per page, option cards, tray Dismiss · Back · Next / Submit. `onDismiss`: Claude Code's Esc (stops the turn). */
export function QuestionPanel({ part, onAnswer, onDismiss }: { part: QuestionRequest; onAnswer: (answers: Record<string, string>) => void; onDismiss?: () => void }) {
  const [choices, setChoices] = useState<Choice[]>(() => part.questions.map(() => ({ chosen: [] })));
  const [page, setPage] = useState(0);
  const answers = part.questions.map((q, i) => answerText(q, choices[i]!));
  const set = (i: number, c: Choice) => setChoices((all) => all.map((x, j) => (j === i ? c : x)));
  const last = page === part.questions.length - 1;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!last) return answers[page] && setPage(page + 1);
    onAnswer(Object.fromEntries(part.questions.map((q, i) => [q.question, answers[i]!])));
  };
  const q = part.questions[page]!;
  const c = choices[page]!;
  const type = q.multiSelect ? "checkbox" : "radio";
  const toggle = (label: string) => set(page, q.multiSelect ? { ...c, chosen: c.chosen.includes(label) ? c.chosen.filter((l) => l !== label) : [...c.chosen, label] } : { chosen: [label] });
  const preview = q.options.find((o) => o.preview && c.chosen.includes(o.label))?.preview;
  const card = (selected: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-md border bg-muted py-2 pr-2 pl-2.5 hover:bg-card ${selected ? "ring-2 ring-foreground" : ""}`;
  return (
    <form onSubmit={submit} className={`${DOCK} max-h-[60vh]`} data-testid="question-panel" aria-label="Question">
      <fieldset key={q.question} className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <span className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground">{q.header}</span>
          {page + 1} of {part.questions.length} questions
        </p>
        <legend className="contents">
          <span className="font-medium">{q.question}</span>
        </legend>
        <p className="text-muted-foreground text-xs">{q.multiSelect ? "Select all answers that apply" : "Select one answer"}</p>
        {q.options.map((o) => (
          <label key={o.label} className={card(c.chosen.includes(o.label))}>
            <input type={type} name={q.question} className="mt-1" checked={c.chosen.includes(o.label)} onChange={() => toggle(o.label)} />
            <span>
              {o.label}
              <span className="block text-muted-foreground text-xs">{o.description}</span>
            </span>
          </label>
        ))}
        <label className={card(c.other !== undefined)}>
          <input
            type={type}
            name={q.question}
            className="mt-1"
            checked={c.other !== undefined}
            onChange={() => set(page, q.multiSelect ? { ...c, other: c.other === undefined ? "" : undefined } : { chosen: [], other: c.other ?? "" })}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            Type your own answer
            <input
              className="min-w-0 rounded-md border bg-transparent px-2 py-1 pointer-coarse:text-base"
              aria-label={`Other answer to: ${q.question}`}
              placeholder="Type your answer..."
              value={c.other ?? ""}
              // Typing chooses Other; for a single-select question it replaces the chosen option.
              onChange={(e) => set(page, q.multiSelect ? { ...c, other: e.target.value } : { chosen: [], other: e.target.value })}
            />
          </span>
        </label>
        {preview && <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">{preview}</pre>}
      </fieldset>
      <div className={TRAY}>
        {onDismiss && (
          <Button type="button" variant="ghost" className="mr-auto" title="Dismiss (Esc): stops the turn" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
        {page > 0 && (
          <Button type="button" variant="outline" onClick={() => setPage(page - 1)}>
            Back
          </Button>
        )}
        <Button type="submit" variant={last ? "default" : "outline"} disabled={last ? answers.some((a) => !a) : !answers[page]}>
          {last ? "Submit" : "Next"}
        </Button>
      </div>
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
