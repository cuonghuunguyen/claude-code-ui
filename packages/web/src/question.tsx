// Question panel (replaces the prompt box) and its timeline marker (docs/spec.md "Questions").
import { useState, type FormEvent, type ReactNode } from "react";
import type { Question } from "@claude-ui/protocol";
import { CircleCheckIcon, CircleHelpIcon, CircleIcon, CircleXIcon, TriangleAlertIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { useT } from "./i18n.ts";
import { DOCK, TRAY } from "./permission.tsx";
import type { QuestionRequest } from "./store.ts";
import { VisualizeAnswerContext } from "./visualize-block.tsx";

/** `other`: the Other free text, undefined while Other is not chosen. */
export type Choice = { chosen: string[]; other?: string };

/** The answer Claude gets: chosen labels in option order, then the Other text, joined with ", " (the SDK's multi-select format). */
export function answerText(q: Question, { chosen, other }: Choice): string {
  const labels = q.options.map((o) => o.label).filter((l) => chosen.includes(l));
  const text = other?.trim();
  return [...labels, ...(text ? [text] : [])].join(", ");
}

/** The same answer as a list for an Engine that needs the structure: chosen labels in option order, then the Other text. */
export function answerList(q: Question, { chosen, other }: Choice): string[] {
  const text = other?.trim();
  return [...q.options.map((o) => o.label).filter((l) => chosen.includes(l)), ...(text ? [text] : [])];
}

/** Preview controls: only a diagram's fullscreen, so a small preview (two columns on a phone) can be read. */
const PREVIEW_CONTROLS = { code: false, table: false, image: false, mermaid: { fullscreen: true, copy: false, download: false, panZoom: false } } as const;

/** OpenCode question dock: one question per page, option cards, tray Dismiss · Back · Next / Submit. `onDismiss`: Claude Code's Esc (stops the turn). */
export function QuestionPanel({ part, onAnswer, onDismiss, mode }: { part: QuestionRequest; onAnswer: (answers: Record<string, string>, choices: Record<string, string[]>) => void; onDismiss?: () => void; mode?: ReactNode }) {
  const t = useT();
  const [choices, setChoices] = useState<Choice[]>(() => part.questions.map(() => ({ chosen: [] })));
  const [page, setPage] = useState(0);
  const answers = part.questions.map((q, i) => answerText(q, choices[i]!));
  const set = (i: number, c: Choice) => setChoices((all) => all.map((x, j) => (j === i ? c : x)));
  const last = page === part.questions.length - 1;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!last) return answers[page] && setPage(page + 1);
    onAnswer(Object.fromEntries(part.questions.map((q, i) => [q.question, answers[i]!])), Object.fromEntries(part.questions.map((q, i) => [q.question, answerList(q, choices[i]!)])));
  };
  const q = part.questions[page]!;
  const c = choices[page]!;
  const type = q.multiSelect ? "checkbox" : "radio";
  const toggle = (label: string) => set(page, q.multiSelect ? { ...c, chosen: c.chosen.includes(label) ? c.chosen.filter((l) => l !== label) : [...c.chosen, label] } : { chosen: [label] });
  // A visualization in the card may fill the Other text (VisualizeAnswerContext); the user still submits.
  const fillOther = (text: string) => set(page, q.multiSelect ? { ...c, other: text } : { chosen: [], other: text });
  const previews = q.options.filter((o) => o.preview);
  const card = (selected: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-md border bg-muted py-2 pr-2 pl-2.5 hover:bg-card ${selected ? "ring-2 ring-foreground" : ""}`;
  return (
    <form onSubmit={submit} className={`${DOCK} max-h-[60dvh]`} data-testid="question-panel" aria-label={t("session.question.label")}>
      {/* The scroller is a div: a fieldset does not scroll reliably everywhere. The tray below stays in view. */}
      <div className="min-h-0 overflow-y-auto overscroll-contain">
      {part.escalated && (
        <p className="flex items-start gap-2 px-3 pt-3 text-xs" data-testid="question-escalated">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 break-words">
            <span className="font-medium">{t("session.permission.escalated")}</span> {part.reason}
          </span>
        </p>
      )}
      <VisualizeAnswerContext value={fillOther}>
      <fieldset key={q.question} className="flex flex-col gap-2 p-3" aria-labelledby={`${part.id}-q${page}`}>
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <span className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground">{q.header}</span>
          {t("session.question.page", { page: page + 1, total: part.questions.length })}
        </p>
        {/* Markdown, so no <legend> (phrasing content only): the fieldset is named by aria-labelledby. */}
        <div id={`${part.id}-q${page}`} className="font-medium" data-testid="question-text">
          <MessageResponse mode="static">{q.question}</MessageResponse>
        </div>
        {previews.length > 0 && (
          // Above the options, every option's preview side by side so they compare at a glance; the header chooses its option.
          <div className={`grid gap-2 ${previews.length > 1 ? "grid-cols-2" : ""} ${previews.length > 2 ? "lg:grid-cols-3" : ""}`} data-testid="question-previews">
            {previews.map((o) => {
              const on = c.chosen.includes(o.label);
              return (
                <div key={o.label} className={`flex min-w-0 flex-col overflow-hidden rounded-md border ${on ? "ring-2 ring-foreground" : ""}`} data-testid="question-preview">
                  <button
                    type="button"
                    className="flex min-h-8 items-center gap-1.5 border-b bg-muted px-2 text-left text-xs hover:bg-card focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                    aria-pressed={on}
                    onClick={() => toggle(o.label)}
                  >
                    {on ? <CircleCheckIcon className="size-3.5 shrink-0" aria-hidden /> : <CircleIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="min-w-0 truncate font-medium">{o.label}</span>
                  </button>
                  <div className="max-h-56 min-w-0 overflow-auto p-2 text-sm">
                    <MessageResponse mode="static" controls={PREVIEW_CONTROLS}>{o.preview}</MessageResponse>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-muted-foreground text-xs">{q.multiSelect ? t("session.question.selectMany") : t("session.question.selectOne")}</p>
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
            {t("session.question.own")}
            <input
              className="min-w-0 rounded-md border bg-transparent px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:text-base"
              aria-label={t("session.question.otherLabel", { question: q.question })}
              placeholder={t("session.question.otherPlaceholder")}
              value={c.other ?? ""}
              // Typing chooses Other; for a single-select question it replaces the chosen option.
              onChange={(e) => set(page, q.multiSelect ? { ...c, other: e.target.value } : { chosen: [], other: e.target.value })}
            />
          </span>
        </label>
      </fieldset>
      </VisualizeAnswerContext>
      </div>
      <div className={TRAY}>
        {mode && <span className="min-w-0">{mode}</span>}
        {onDismiss && (
          <Button type="button" variant="ghost" className="mr-auto" title={t("session.question.dismissHint")} onClick={onDismiss}>
            {t("session.question.dismiss")}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          {page > 0 && (
            <Button type="button" variant="outline" onClick={() => setPage(page - 1)}>
              {t("session.question.back")}
            </Button>
          )}
          <Button type="submit" variant={last ? "default" : "outline"} className={last ? "bg-send shadow-button-contrast hover:bg-send/80" : undefined} disabled={last ? answers.some((a) => !a) : !answers[page]}>
            {last ? t("session.question.submit") : t("session.question.next")}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function QuestionMarker({ part }: { part: QuestionRequest }) {
  const t = useT();
  const [label, Icon, className] = !part.settled
    ? [t("session.question.waiting"), CircleHelpIcon, "text-info"]
    : part.answers
      ? [part.questions.map((q) => `${q.header}: ${part.answers![q.question] ?? ""}`).join(" · "), CircleCheckIcon, "text-success"]
      : [t("session.question.cancelled"), CircleXIcon, "text-muted-foreground"];
  return (
    <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs" data-testid="question-marker" data-settled={part.settled}>
      <Icon className={`size-4 shrink-0 ${className}`} />
      <span className="shrink-0">{part.settled && part.answers && part.by === "coordinator" ? t("session.question.markerCoordinator") : t("session.question.marker")}</span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}
