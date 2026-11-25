// Question panel (replaces the prompt box) and its timeline marker (docs/spec.md "Questions").
import { useState, type FormEvent, type ReactNode } from "react";
import { checkAnswer, isActive, type InputError, type Question } from "@claude-ui/protocol";
import { CircleCheckIcon, CircleHelpIcon, CircleIcon, CircleXIcon } from "lucide-react";
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
  let text = other?.trim();
  // A date-time input holds the local value; the answer is RFC 3339 (UTC, no fraction).
  if (text && q.input?.type === "date-time") {
    const at = new Date(text);
    text = Number.isNaN(at.getTime()) ? text : at.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  return [...labels, ...(text ? [text] : [])].join(", ");
}

/** The same answer as a list for an Engine that needs the structure: chosen labels in option order, then the Other text. */
export function answerList(q: Question, { chosen, other }: Choice): string[] {
  const text = other?.trim();
  return [...q.options.map((o) => o.label).filter((l) => chosen.includes(l)), ...(text ? [text] : [])];
}

/** The pre-filled choice of a question: its `default` as chosen labels, else as the free text. */
function initial(q: Question): Choice {
  if (q.default === undefined) return { chosen: [] };
  if (q.input?.type === "date-time") {
    // The input shows local time.
    const at = new Date(q.default);
    const pad = (n: number) => String(n).padStart(2, "0");
    return { chosen: [], other: Number.isNaN(at.getTime()) ? q.default : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` };
  }
  if (q.input) return { chosen: [], other: q.default };
  const labels = q.options.map((o) => o.label);
  const chosen = q.multiSelect ? labels.filter((l) => q.default!.split(", ").includes(l)) : labels.filter((l) => l === q.default);
  return chosen.length ? { chosen } : { chosen: [], other: q.default };
}

const HTML_TYPE = { text: "text", number: "number", integer: "number", date: "date", "date-time": "datetime-local", email: "email", uri: "url" } as const;
const STEP = { integer: 1, number: "any", "date-time": 1 } as Partial<Record<NonNullable<Question["input"]>["type"], number | string>>;
const INPUT_MODE = { number: "decimal", integer: "numeric", email: "email", uri: "url" } as const;
const ERROR_KEY = { number: "number", integer: "integer", minimum: "minimum", maximum: "maximum", minLength: "minLength", maxLength: "maxLength", pattern: "pattern", date: "date", "date-time": "dateTime", email: "email", uri: "uri" } as const satisfies Record<InputError["code"], string>;

/** Preview controls: only a diagram's fullscreen, so a small preview (two columns on a phone) can be read. */
const PREVIEW_CONTROLS = { code: false, table: false, image: false, mermaid: { fullscreen: true, copy: false, download: false, panZoom: false } } as const;

/** OpenCode question dock: one question per page, option cards, tray Dismiss · Back · Next / Submit. `onDismiss`: Claude Code's Esc (stops the turn). */
export function QuestionPanel({ part, onAnswer, onDismiss, mode }: { part: QuestionRequest; onAnswer: (answers: Record<string, string>, choices: Record<string, string[]>) => void; onDismiss?: () => void; mode?: ReactNode }) {
  const t = useT();
  const [choices, setChoices] = useState<Choice[]>(() => part.questions.map(initial));
  const [pageAt, setPage] = useState(0);
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const answers = part.questions.map((q, i) => answerText(q, choices[i]!));
  const byText = Object.fromEntries(part.questions.map((q, i) => [q.question, answers[i]!]));
  // A question whose `when` fails is not a page and not sent; its answer stays in state.
  const active = part.questions.map((q) => isActive(q, byText, part.questions));
  const activeIdx = part.questions.flatMap((_, i) => (active[i] ? [i] : []));
  // The page shown: the one asked for while it is active, else the next active one (the first answer may make the first page inactive), else the last active.
  const page = active[pageAt] ? pageAt : (activeIdx.find((i) => i > pageAt) ?? activeIdx.at(-1) ?? pageAt);
  const problem = (i: number): InputError | undefined => {
    const q = part.questions[i]!;
    // A free text next to options is checked; an option's label is not.
    return q.input && answers[i] && !q.options.some((o) => o.label === answers[i]) ? checkAnswer(q.input, answers[i]!) : undefined;
  };
  const ready = (i: number) => (answers[i] ? !problem(i) : !!part.questions[i]!.optional);
  const set = (i: number, c: Choice) => setChoices((all) => all.map((x, j) => (j === i ? c : x)));
  const next = activeIdx.find((i) => i > page);
  const prev = activeIdx.filter((i) => i < page).pop();
  const last = next === undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready(page)) return setTouched((all) => new Set(all).add(page));
    if (!last) return setPage(next);
    if (!activeIdx.every(ready)) return;
    const sent = activeIdx.filter((i) => answers[i]);
    onAnswer(Object.fromEntries(sent.map((i) => [part.questions[i]!.question, answers[i]!])), Object.fromEntries(sent.map((i) => [part.questions[i]!.question, answerList(part.questions[i]!, choices[i]!)])));
  };
  const q = part.questions[page]!;
  const c = choices[page]!;
  const type = q.multiSelect ? "checkbox" : "radio";
  const typed = q.input && q.options.length === 0 ? q.input : undefined;
  const bad = touched.has(page) ? problem(page) : undefined;
  const errorText = bad ? t(`session.question.error.${ERROR_KEY[bad.code]}`, { limit: String(bad.limit ?? "") }) : "";
  const toggle = (label: string) => set(page, q.multiSelect ? { ...c, chosen: c.chosen.includes(label) ? c.chosen.filter((l) => l !== label) : [...c.chosen, label] } : { chosen: [label] });
  // A visualization in the card may fill the Other text (VisualizeAnswerContext); the user still submits.
  const fillOther = (text: string) => set(page, q.multiSelect ? { ...c, other: text } : { chosen: [], other: text });
  const previews = q.options.filter((o) => o.preview);
  const card = (selected: boolean) =>
    `flex cursor-pointer items-start gap-3 rounded-md border bg-muted py-2 pr-2 pl-2.5 hover:bg-card ${selected ? "ring-2 ring-foreground" : ""}`;
  return (
    <form onSubmit={submit} className={`${DOCK} max-h-[60dvh]`} data-testid="question-panel" data-part="question-panel" aria-label={t("session.question.label")}>
      {/* The scroller is a div: a fieldset does not scroll reliably everywhere. The tray below stays in view. */}
      <div className="min-h-0 overflow-y-auto overscroll-contain">
      <VisualizeAnswerContext value={fillOther}>
      <fieldset key={q.question} className="flex flex-col gap-2 p-3" aria-labelledby={`${part.id}-q${page}`}>
        <p className="flex items-center gap-2 text-muted-foreground text-xs">
          <span className="rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground">{q.header}</span>
          {q.optional && <span className="rounded border px-1.5 py-0.5">{t("session.question.optional")}</span>}
          {t("session.question.page", { page: activeIdx.indexOf(page) + 1, total: activeIdx.length })}
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
        {!typed && <p className="text-muted-foreground text-xs">{q.multiSelect ? t("session.question.selectMany") : t("session.question.selectOne")}</p>}
        {q.options.map((o) => (
          <label key={o.label} className={card(c.chosen.includes(o.label))}>
            <input type={type} name={q.question} className="mt-1" checked={c.chosen.includes(o.label)} onChange={() => toggle(o.label)} />
            <span>
              {o.label}
              <span className="block text-muted-foreground text-xs">{o.description}</span>
            </span>
          </label>
        ))}
        {typed ? (
          <>
            <input
              key={q.question}
              id={`${part.id}-in${page}`}
              type={HTML_TYPE[typed.type]}
              className="min-w-0 rounded-md border bg-transparent px-2 py-1 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:text-base"
              aria-labelledby={`${part.id}-q${page}`}
              aria-invalid={!!bad}
              aria-describedby={bad ? `${part.id}-err${page}` : undefined}
              placeholder={typed.placeholder ?? t("session.question.otherPlaceholder")}
              value={c.other ?? ""}
              inputMode={INPUT_MODE[typed.type as keyof typeof INPUT_MODE]}
              step={STEP[typed.type]}
              min={typed.type === "number" || typed.type === "integer" ? typed.minimum : undefined}
              max={typed.type === "number" || typed.type === "integer" ? typed.maximum : undefined}
              minLength={typed.type === "text" ? typed.minLength : undefined}
              maxLength={typed.type === "text" ? typed.maxLength : undefined}
              onChange={(e) => set(page, { chosen: [], other: e.target.value })}
              onBlur={() => setTouched((all) => new Set(all).add(page))}
            />
            {bad && (
              <p id={`${part.id}-err${page}`} className="text-destructive text-xs" role="alert">
                {errorText}
              </p>
            )}
          </>
        ) : (
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
              aria-invalid={!!bad}
              aria-describedby={bad ? `${part.id}-err${page}` : undefined}
              onBlur={() => setTouched((all) => new Set(all).add(page))}
              // Typing chooses Other; for a single-select question it replaces the chosen option.
              onChange={(e) => set(page, q.multiSelect ? { ...c, other: e.target.value } : { chosen: [], other: e.target.value })}
            />
          </span>
        </label>
        )}
        {!typed && bad && (
          <p id={`${part.id}-err${page}`} className="text-destructive text-xs" role="alert">
            {errorText}
          </p>
        )}
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
          {prev !== undefined && (
            <Button type="button" variant="outline" onClick={() => setPage(prev)}>
              {t("session.question.back")}
            </Button>
          )}
          <Button type="submit" variant={last ? "default" : "outline"} className={last ? "bg-send shadow-button-contrast hover:bg-send/80" : undefined} disabled={last ? !activeIdx.every(ready) : !ready(page)}>
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
      <span className="shrink-0">{t("session.question.marker")}</span>
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}
