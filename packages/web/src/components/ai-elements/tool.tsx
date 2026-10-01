"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  LoaderCircleIcon,
  ShieldAlertIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";

import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose w-full", className)} {...props} />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  /** One-line summary of the input, shown after the tool name. */
  summary?: string;
  /** Shown before the status, e.g. diff stats. */
  meta?: ReactNode;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

// Icon-only while in progress or done; outcomes that need attention also show their label.
const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ShieldAlertIcon className="size-4 text-amber-600" />,
  "approval-responded": <CheckIcon className="size-4 text-muted-foreground" />,
  "input-available": <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />,
  "input-streaming": <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />,
  "output-available": <CheckIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};
const labelled = new Set<ToolPart["state"]>(["approval-requested", "output-denied", "output-error"]);

export const ToolStatusMark = ({ state }: { state: ToolPart["state"] }) => (
  <span className="flex items-center gap-1 text-muted-foreground text-xs" title={statusLabels[state]} data-state={state}>
    {statusIcons[state]}
    {labelled.has(state) ? statusLabels[state] : <span className="sr-only">{statusLabels[state]}</span>}
  </span>
);

/** Borderless row: tool name, muted summary, meta, status, chevron (OpenCode basic-tool trigger). */
export const ToolHeader = ({
  className,
  title,
  summary,
  meta,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  return (
    <CollapsibleTrigger
      className={cn(
        "flex min-h-6 w-full cursor-pointer items-center gap-2 rounded-md text-left text-sm hover:bg-muted/50",
        className
      )}
      {...props}
    >
      <span className="shrink-0 font-medium">{title ?? derivedName}</span>
      {summary && <span className="min-w-0 truncate text-muted-foreground">{summary}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {meta}
        <ToolStatusMark state={state} />
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform in-data-panel-open:rotate-180 motion-reduce:transition-none" />
      </span>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-2 pt-1 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
