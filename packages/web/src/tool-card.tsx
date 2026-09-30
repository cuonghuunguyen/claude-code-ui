// Tool cards, context groups and thinking blocks (docs/spec.md "Message model", "Session view UX").
import type { Part, TodoItem, ToolStatus } from "@claude-ui/protocol";
import type { FileDiffOptions } from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { ToolUIPart } from "ai";
import { useMemo, useState, type ReactNode } from "react";
import {
  BotIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { Task, TaskContent, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Badge } from "@/components/ui/badge";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { parseAnsi } from "./ansi.ts";
import type { ToolCall } from "./store.ts";
import { editFiles, readRange, toolSummary } from "./tools.ts";

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

// ponytail: light only, like the app (nothing sets `.dark` yet); pass themeType "dark" when a theme toggle lands.
const DIFF_OPTIONS: FileDiffOptions<undefined, undefined> = {
  diffStyle: "unified",
  theme: { light: "pierre-light", dark: "pierre-dark" },
  themeType: "light",
  overflow: "wrap",
  disableFileHeader: true,
};

// Tools whose card starts expanded (docs/spec.md "Session view UX": Bash and edits expanded).
const EXPANDED = new Set(["Bash", "Edit", "Write"]);

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
    case "Edit":
    case "Write":
      return <EditDiff call={call} result={result} />;
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

/** Unified diff built from the Edit/Write input; the JSON parameters until the input has streamed in. */
function EditDiff({ call, result }: { call: ToolCall; result?: ToolResult }) {
  return (
    <>
      <InputDiff tool={call.tool} input={call.input} fallback={<ToolInput input={call.input} />} />
      {result && (
        <ToolOutput
          output={result.isError ? undefined : result.output}
          errorText={result.isError ? text(result.output) : undefined}
        />
      )}
    </>
  );
}

/** The Edit/Write diff of a tool input; `fallback` while the input is incomplete. Also used by the permission panel. */
export function InputDiff({ tool, input, fallback }: { tool: string; input: unknown; fallback?: ReactNode }) {
  const files = useMemo(() => editFiles(tool, input), [tool, input]);
  if (!files) return fallback;
  return (
    <div className="overflow-hidden rounded-md border text-xs" data-testid="edit-diff">
      <MultiFileDiff oldFile={files.oldFile} newFile={files.newFile} options={DIFF_OPTIONS} />
    </div>
  );
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

type Subagent = Extract<Part, { type: "subagent" }>;

/** A subagent run: header with description and status; `children` is its nested timeline. */
export function SubagentGroup({ part, result, children }: { part: Subagent; result?: ToolResult; children: ReactNode }) {
  return (
    // Open when it mounts live (pending/running), so its activity shows; finished ones from history mount collapsed.
    <Tool data-testid="subagent" data-status={part.status} defaultOpen={part.status === "pending" || part.status === "running"}>
      <ToolHeader
        type="dynamic-tool"
        toolName="Agent"
        state={STATE[part.status]}
        summary={part.description}
        icon={<BotIcon className="size-4 shrink-0 text-muted-foreground" />}
      />
      <ToolContent className="space-y-2 border-l-2 p-2 pl-3">
        {children}
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

const TODO_ICONS: Record<TodoItem["status"], ReactNode> = {
  completed: <CheckCircle2Icon className="size-4 shrink-0 text-green-600" />,
  in_progress: <CircleDotIcon className="size-4 shrink-0 animate-pulse text-foreground" />,
  pending: <CircleIcon className="size-4 shrink-0" />,
};

/** The pinned todo list (TodoWrite); an in-progress item shows its active form. */
export function TodoList({ items }: { items: TodoItem[] }) {
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <Task className="rounded-lg border bg-background p-3" data-testid="todo-list">
      <TaskTrigger title="Todos">
        <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm hover:text-foreground">
          <ListTodoIcon className="size-4" />
          <span>
            Todos {done}/{items.length}
          </span>
        </div>
      </TaskTrigger>
      <TaskContent>
        {items.map((item, i) => (
          <TaskItem
            key={i}
            data-status={item.status}
            className={`flex items-center gap-2 ${item.status === "completed" ? "line-through" : item.status === "in_progress" ? "text-foreground" : ""}`}
          >
            {TODO_ICONS[item.status]}
            {item.status === "in_progress" ? (item.activeForm ?? item.content) : item.content}
          </TaskItem>
        ))}
      </TaskContent>
    </Task>
  );
}
