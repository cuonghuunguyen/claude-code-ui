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
import { Badge } from "@/components/ui/badge";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ToolCall } from "./store.ts";
import { toolSummary } from "./tools.ts";

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

export function ToolCard({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const Icon = ICONS[call.tool] ?? WrenchIcon;
  return (
    <Tool data-testid="tool-card" data-status={call.status}>
      <ToolHeader
        type="dynamic-tool"
        toolName={call.tool}
        state={STATE[call.status]}
        summary={toolSummary(call.input)}
        icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
      />
      <ToolContent>
        <ToolInput input={call.input} />
        {result && (
          <ToolOutput
            output={result.isError ? undefined : result.output}
            errorText={result.isError ? text(result.output) : undefined}
          />
        )}
      </ToolContent>
    </Tool>
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
