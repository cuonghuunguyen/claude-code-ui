// Tool cards, context groups and thinking blocks (docs/spec.md "Message model", "Session view UX").
import type { Part, ToolStatus } from "@claude-ui/protocol";
import type { ToolUIPart } from "ai";
import {
  BotIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { parseAnsi } from "./ansi.ts";
import type { ToolCall } from "./store.ts";
import { readRange, toolSummary } from "./tools.ts";

type ToolResult = Extract<Part, { type: "tool_result" }>;

const STATE: Record<ToolStatus, ToolUIPart["state"]> = {
  pending: "input-streaming",
  running: "input-available",
  done: "output-available",
  error: "output-error",
  denied: "output-denied",
};

const ICONS: Record<string, LucideIcon> = {
  Read: FileTextIcon,
  Grep: SearchIcon,
  Glob: SearchIcon,
  Bash: TerminalIcon,
  Edit: FilePenIcon,
  Write: FilePenIcon,
  NotebookEdit: FilePenIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Task: BotIcon,
  Agent: BotIcon,
  TodoWrite: ListTodoIcon,
};

const text = (output: unknown) => (typeof output === "string" ? output : JSON.stringify(output, null, 2));

// Tools whose card starts expanded (docs/spec.md "Session view UX": Bash and edits expanded).
const EXPANDED = new Set(["Bash"]);

export function ToolCard({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const Icon = ICONS[call.tool] ?? WrenchIcon;
  const range = call.tool === "Read" ? readRange(call.input, result?.output) : "";
  return (
    <Tool data-testid="tool-card" data-status={call.status} defaultOpen={EXPANDED.has(call.tool)}>
      <ToolHeader
        type="dynamic-tool"
        toolName={call.tool}
        state={STATE[call.status]}
        summary={[toolSummary(call.input), range].filter(Boolean).join(" · ")}
        icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
      />
      <ToolContent>
        <ToolBody call={call} result={result} />
      </ToolContent>
    </Tool>
  );
}

const field = (input: unknown, key: string) => {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
};

/** Card body by tool type; tools without a purpose-built body get the generic JSON view. */
export function ToolBody({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const output = result && <Lines text={text(result.output)} error={result.isError} ansi={call.tool === "Bash"} />;
  switch (call.tool) {
    case "Bash":
      return (
        <div className="space-y-2">
          <pre data-testid="bash-command" className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">
            <span className="select-none text-muted-foreground">$ </span>
            {field(call.input, "command")}
          </pre>
          {output}
        </div>
      );
    case "Read":
      return (
        <div className="space-y-2">
          <div data-testid="read-path" className="font-mono text-xs">
            {field(call.input, "file_path")}
            <span className="text-muted-foreground"> {readRange(call.input, result?.output)}</span>
          </div>
          {output}
        </div>
      );
    case "Grep":
    case "Glob": {
      const scope = [field(call.input, "path"), field(call.input, "glob")].filter(Boolean).join(" ");
      return (
        <div className="space-y-2">
          <div data-testid="search-pattern" className="font-mono text-xs">
            {field(call.input, "pattern")}
            {scope && <span className="text-muted-foreground"> in {scope}</span>}
          </div>
          {output}
        </div>
      );
    }
    default:
      return (
        <>
          <ToolInput input={call.input} />
          {result && (
            <ToolOutput
              output={result.isError ? undefined : result.output}
              errorText={result.isError ? text(result.output) : undefined}
            />
          )}
        </>
      );
  }
}

const MAX_LINES = 20;

/** Monospace output, cut to MAX_LINES lines until expanded. */
function Lines({ text, error, ansi }: { text: string; error: boolean; ansi: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = all ? lines.join("\n") : lines.slice(0, MAX_LINES).join("\n");
  return (
    <div>
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre rounded-md p-2 font-mono text-xs",
          error ? "bg-destructive/10 text-destructive" : "bg-muted/50",
        )}
      >
        {ansi
          ? parseAnsi(shown).map((seg, i) => (
              <span key={i} style={seg.style}>
                {seg.text}
              </span>
            ))
          : shown}
      </pre>
      {lines.length > MAX_LINES && (
        <button type="button" className="mt-1 text-muted-foreground text-xs hover:underline" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

export function ContextGroup({ calls, result }: { calls: ToolCall[]; result: (call: ToolCall) => ToolResult | undefined }) {
  const failed = calls.some((c) => c.status === "error" || c.status === "denied");
  const busy = calls.some((c) => c.status === "pending" || c.status === "running");
  return (
    <Tool data-testid="context-group">
      <CollapsibleTrigger className="flex w-full items-center gap-2 p-3">
        <SearchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">Context</span>
        <Badge className="rounded-full text-xs" variant="secondary">
          {calls.length}
        </Badge>
        <span className="truncate text-muted-foreground text-xs">
          {[...new Set(calls.map((c) => c.tool))].join(", ")}
          {busy ? " · running" : failed ? " · some failed" : ""}
        </span>
      </CollapsibleTrigger>
      <ToolContent className="space-y-2 p-2">
        {calls.map((c) => (
          <ToolCard key={c.id} call={c} result={result(c)} />
        ))}
      </ToolContent>
    </Tool>
  );
}

export function Thinking({ part }: { part: Extract<Part, { type: "thinking" }> }) {
  return (
    <Reasoning isStreaming={part.streaming} defaultOpen={false} data-testid="thinking">
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  );
}
