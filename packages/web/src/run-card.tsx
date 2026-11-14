// Run card (docs/spec.md "Inline tasks (GH-734)"): one collapsible card for a nested agent run, shared by inline tasks and later Fork runs (GH-718).
// Header: status, label, summary, `model · turns · tokens`, Stop while running. Body: a collapsed "N steps" disclosure (the run's child parts), the result, the changed files.
import type { ToolStatus } from "@claude-ui/protocol";
import type { ToolUIPart } from "ai";
import { SquareIcon } from "lucide-react";
import { createContext, use, useState, type ReactNode } from "react";
import { ToolChevron, ToolContent, ToolHeader, Tool } from "@/components/ai-elements/tool";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { tokens } from "./status-bar.tsx";
import { inlineTaskResult, inlineTaskSummary, inlineTokens, type InlineTokens } from "./tools.ts";
import { MessageResponse } from "@/components/ai-elements/message";
import type { Part } from "@claude-ui/protocol";
import type { ToolCall } from "./store.ts";
import { t as tr, useT } from "./i18n.ts";
import { useExpanded } from "./tool-card.tsx";

const STATE: Record<ToolStatus, ToolUIPart["state"]> = {
  pending: "input-streaming",
  running: "input-available",
  done: "output-available",
  error: "output-error",
  denied: "output-denied",
  stopped: "output-denied",
};

export type RunCardProps = {
  /** Expand-state key; the tool call id. */
  id: string;
  /** Card title: "Inline task", later "Fork". */
  label: string;
  /** One line after the label (truncated). */
  summary: string;
  status: ToolStatus;
  model?: string;
  usage?: InlineTokens;
  turns?: { used: number; max?: number };
  filesChanged?: string[];
  /** Shown in the body below the steps (the result text, notes). */
  result?: ReactNode;
  /** The run's child timeline. */
  steps: ReactNode;
  stepCount: number;
  /** False: the run has no child parts although it ended (daemon restart): the steps section says so. Default true. */
  stepsKept?: boolean;
  /** Stop button while the run is pending or running; a rejection shows as an alert. */
  onCancel?: () => void | Promise<unknown>;
  /** A step waits for a permission answer: card and steps are held open. */
  awaiting?: boolean;
};

const FOCUS = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info";

/** `model · 3/10 turns · 2.0k tokens`, what is known. */
export function runMeta({ model, turns, usage }: Pick<RunCardProps, "model" | "turns" | "usage">): string {
  return [
    model,
    turns && (turns.max ? tr("session.run.turnsOf", { used: turns.used, max: turns.max }) : tr("session.run.turns", { count: turns.used })),
    usage && tr("session.run.tokens", { count: tokens(inlineTokens(usage)) }),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function RunCard({ id, label, summary, status, model, usage, turns, filesChanged = [], result, steps, stepCount, stepsKept = true, onCancel, awaiting }: RunCardProps) {
  const t = useT();
  const meta = runMeta({ model, turns, usage });
  const active = status === "running" || status === "pending";
  const [stop, setStop] = useState<{ pending: boolean; error?: string }>();
  const stepsOpen = useExpanded(`${id}:steps`, awaiting);
  const lost = stepCount === 0 && !stepsKept;
  const doStop = () => {
    setStop({ pending: true });
    Promise.resolve(onCancel!()).then(
      () => setStop(undefined),
      (e: Error) => setStop({ pending: false, error: e.message }),
    );
  };
  return (
    <Tool data-testid="run-card" data-status={status} className="min-w-0" {...useExpanded(id, awaiting)}>
      <div className="flex items-center gap-1">
        <ToolHeader
          type="dynamic-tool"
          toolName={label}
          state={awaiting ? "approval-requested" : STATE[status]}
          statusLabel={awaiting ? undefined : status === "stopped" ? t("session.toolCard.stopped") : undefined}
          summary={summary}
          meta={meta && <span data-testid="run-meta" className="text-muted-foreground text-xs tabular-nums max-md:hidden">{meta}</span>}
          className="min-w-0 flex-1"
        />
        {active && onCancel && (
          <button
            type="button"
            data-testid="run-stop"
            aria-label={t("session.run.stop", { label, summary })}
            title={t("session.run.stop", { label, summary })}
            disabled={stop?.pending}
            className={cn("flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50 pointer-coarse:size-11", FOCUS)}
            onClick={doStop}
          >
            <SquareIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {/* Narrow screens: the header has no room for the meta, so it wraps on its own row. */}
      {meta && (
        <p data-testid="run-meta-compact" className="flex flex-wrap gap-x-2 px-3 pb-1 text-muted-foreground text-xs tabular-nums [overflow-wrap:anywhere] md:hidden">
          {meta}
        </p>
      )}
      {stop?.error && (
        <p role="alert" data-testid="run-stop-error" className="px-3 pb-1 text-destructive text-xs [overflow-wrap:anywhere]">
          {t("session.run.stopFailed", { error: stop.error })}
        </p>
      )}
      <ToolContent className="min-w-0 space-y-2 border-l-2 pl-3">
        {lost ? (
          <p data-testid="run-steps-note" className="text-muted-foreground text-xs">
            {t("session.run.stepsNotKept")}
          </p>
        ) : (
          (stepCount > 0 || awaiting) && (
            <Collapsible data-testid="run-steps" {...stepsOpen}>
              <CollapsibleTrigger
                data-testid="run-steps-toggle"
                className={cn("group/steps flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-muted-foreground text-xs hover:bg-muted/50 pointer-coarse:min-h-11", FOCUS)}
              >
                <span>{t("session.run.steps", { count: stepCount })}</span>
                <ToolChevron />
              </CollapsibleTrigger>
              <CollapsibleContent className="min-w-0 space-y-1 pt-1">{steps}</CollapsibleContent>
            </Collapsible>
          )
        )}
        {result}
        {filesChanged.length > 0 && (
          <div data-testid="run-files" className="min-w-0 text-xs [overflow-wrap:anywhere]">
            <p className="text-muted-foreground">{t("session.run.filesChanged", { count: filesChanged.length })}</p>
            <ul className="font-mono">
              {filesChanged.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </ToolContent>
    </Tool>
  );
}

/** Stops the run of a tool call (`session.stopSubagent`, subagentId = the call id); provided by the session pane. */
export const StopRunContext = createContext<((id: string) => Promise<unknown> | void) | undefined>(undefined);

/** What the timeline gives an inline task card: its rendered child steps. `hasParts`: the run has any child part (none = restored session). */
export type RunSteps = { steps: ReactNode; stepCount: number; hasParts: boolean };

const LIMIT_NOTE = { turns: "session.run.limitTurns", tokens: "session.run.limitTokens", time: "session.run.limitTime" } as const;

/** The `inline_task` tool call (GH-734) as a run card. Live state comes from the call, the rest from its result JSON. */
export function InlineTaskCard({ call, result, awaiting, run }: { call: ToolCall; result?: Extract<Part, { type: "tool_result" }>; awaiting?: boolean; run?: RunSteps }) {
  const t = useT();
  const stop = use(StopRunContext);
  const out = result && inlineTaskResult(result.output);
  const input = (call.input ?? {}) as { model?: unknown; maxTurns?: unknown };
  const active = call.status === "running" || call.status === "pending";
  const status: ToolStatus = active ? call.status : out?.status === "stopped" ? "stopped" : out?.status === "error" ? "error" : call.status;
  const note = out && (out.status === "limit" ? t(LIMIT_NOTE[out.limit ?? "turns"]) : out.status === "stopped" ? t("session.run.stoppedPartial") : out.status === "error" ? t("session.run.error", { error: out.error ?? "" }) : undefined);
  return (
    <RunCard
      id={call.id}
      label={t("session.run.inlineTask")}
      summary={inlineTaskSummary(call.input)}
      status={status}
      model={out?.model ?? (typeof input.model === "string" ? input.model : undefined)}
      usage={out?.tokens}
      turns={out?.turns !== undefined ? { used: out.turns, max: typeof input.maxTurns === "number" ? input.maxTurns : undefined } : undefined}
      filesChanged={out?.filesChanged}
      stepCount={run?.stepCount ?? 0}
      steps={run?.steps}
      stepsKept={(run?.hasParts ?? true) || active}
      awaiting={awaiting}
      onCancel={stop && (() => stop(call.toolUseId))}
      result={
        <>
          {note && (
            <p data-testid="run-note" className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
              {note}
            </p>
          )}
          {out?.text && (
            <div data-testid="run-result" className="min-w-0 text-sm [overflow-wrap:anywhere]">
              <MessageResponse>{out.text}</MessageResponse>
            </div>
          )}
          {out?.truncated && <p className="text-muted-foreground text-xs">{t("session.run.truncated")}</p>}
          {result && !out && (
            <p role="alert" data-testid="run-error" className="whitespace-pre-wrap text-destructive text-xs [overflow-wrap:anywhere]">
              {typeof result.output === "string" ? result.output : JSON.stringify(result.output)}
            </p>
          )}
        </>
      }
    />
  );
}
