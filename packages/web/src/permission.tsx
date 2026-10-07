// Permission panel (replaces the prompt box) and its timeline marker (docs/spec.md "Permission bridge").
import { useState, type FormEvent, type ReactNode } from "react";
import type { PermissionUpdate } from "@claude-ui/protocol";
import { FileDiffIcon, ListTodoIcon, PencilIcon, TriangleAlertIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import type { PermissionRequest } from "./store.ts";
import { InputDiff } from "./tool-card.tsx";

export type PermissionAnswer = {
  decision: "allow" | "allow_always" | "deny";
  ruleIndex?: number;
  message?: string;
  updatedInput?: Record<string, unknown>;
};

/** The input field the user may edit before accepting (docs/spec.md "Permission bridge" 4). */
const EDIT_FIELD: Record<string, string> = { Edit: "new_string", Write: "content" };

const proposed = (part: PermissionRequest) => {
  const v = (part.input as Record<string, unknown> | null)?.[EDIT_FIELD[part.tool]];
  return typeof v === "string" ? v : undefined;
};

/** The full input with the edited content, or undefined when unchanged (then Yes behaves as a normal Yes). */
export function editedInput(part: PermissionRequest, draft: string): Record<string, unknown> | undefined {
  const field = EDIT_FIELD[part.tool];
  const old = proposed(part);
  return old === undefined || draft === old ? undefined : { ...(part.input as Record<string, unknown>), [field]: draft };
}

/** A suggested rule as Claude Code writes it, e.g. `Bash(npm test:*)`. */
export function ruleLabel(s: PermissionUpdate): string {
  switch (s.type) {
    case "addRules":
    case "replaceRules":
    case "removeRules":
      return s.rules.map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(", ");
    case "addDirectories":
    case "removeDirectories":
      return s.directories.join(", ");
    case "setMode":
      return s.mode === "acceptEdits" ? "all edits this session" : `mode ${s.mode}`;
  }
}

const inputText = (input: unknown) => {
  const command = (input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : JSON.stringify(input, null, 2);
};

/** ExitPlanMode's plan (markdown), shown with Claude Code's plan approval options. */
const planOf = (part: PermissionRequest) => {
  const plan = part.tool === "ExitPlanMode" ? (part.input as { plan?: unknown } | null)?.plan : undefined;
  return typeof plan === "string" ? plan : undefined;
};

/** Dock tray (OpenCode DockTray): actions right-aligned under the dock body. */
export const DOCK = "flex flex-col overflow-hidden rounded-xl border bg-card text-sm shadow-sm";
export const TRAY = "@container flex flex-wrap items-center justify-end gap-2 border-t bg-muted px-2 py-2 pointer-coarse:[&_button]:h-11";

/** OpenCode permission dock: header, hint, content, rule patterns; tray Deny · Allow always · Allow once. */
export function PermissionPanel({ part, onRespond, mode }: { part: PermissionRequest; onRespond: (a: PermissionAnswer) => void; mode?: ReactNode }) {
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState(() => proposed(part));
  const [editing, setEditing] = useState(false);
  const updatedInput = draft === undefined ? undefined : editedInput(part, draft);
  const plan = planOf(part);
  const deny = (e: FormEvent) => {
    e.preventDefault();
    onRespond({ decision: "deny", message: feedback.trim() || undefined });
  };
  const noLabel = plan !== undefined ? "No, keep planning: tell Claude what to change" : "No, and tell Claude what to do differently";
  return (
    <form onSubmit={deny} className={`${DOCK} max-h-[60dvh]`} data-testid="permission-panel" aria-label="Permission request">
      {/* The body scrolls inside the bounded panel; the tray below stays in view (same as the question panel). */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain p-3">
        <p className="flex items-center gap-2 font-medium">
          {plan !== undefined ? <ListTodoIcon className="size-4 shrink-0 text-muted-foreground" /> : <TriangleAlertIcon className="size-4 shrink-0 text-warning" />}
          {plan !== undefined ? "Ready to code? Claude has written up a plan" : "Permission required"}
        </p>
        {plan === undefined && <p className="text-muted-foreground">{part.title ?? `Claude wants to use ${part.tool}`}</p>}
        {part.escalated && (
          <p className="text-xs break-words" data-testid="permission-escalated">
            <span className="font-medium">Escalated by coordinator:</span> {part.reason}
          </p>
        )}
        {plan !== undefined ? (
          <div className="max-h-80 overflow-auto rounded-md bg-muted p-3" data-testid="plan">
            <MessageResponse>{plan}</MessageResponse>
          </div>
        ) : draft === undefined ? (
          <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">{inputText(part.input)}</pre>
        ) : (
          <>
            {/* One view of the content at a time (GH-86): the diff, or on "Edit content" the editable text. */}
            {editing ? (
              <textarea
                className="max-h-64 min-h-40 rounded-md border bg-transparent p-2 font-mono text-xs pointer-coarse:text-base"
                aria-label="Proposed new content"
                spellCheck={false}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <div className="max-h-64 overflow-auto">
                <InputDiff tool={part.tool} input={updatedInput ?? part.input} />
              </div>
            )}
            <Button type="button" variant="ghost" size="sm" className="self-end pointer-coarse:h-11" aria-pressed={editing} onClick={() => setEditing(!editing)}>
              {editing ? <FileDiffIcon /> : <PencilIcon />}
              {editing ? "Show diff" : "Edit content"}
            </Button>
          </>
        )}
        {/* Like Claude Code: "Allow always" applies every SDK suggestion (e.g. the Bash rule plus its directory). */}
        {plan === undefined && part.suggestions.length > 0 && (
          <p className="text-muted-foreground text-xs" data-testid="permission-rules">
            Allow always: don&apos;t ask again for <code className="font-mono">{part.suggestions.map(ruleLabel).join(", ")}</code>
          </p>
        )}
        <input
          className="min-w-0 rounded-md border bg-transparent px-2 py-1.5 pointer-coarse:text-base"
          placeholder={noLabel}
          aria-label={noLabel}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
      </div>
      <div className={TRAY}>
        {/* Changing the mode does not answer the request (GH-145). */}
        {mode && <span className="mr-auto min-w-0">{mode}</span>}
        {/* One group: on a narrow tray the answer buttons wrap together, below the picker. */}
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button type="submit" variant="ghost">
            {plan !== undefined ? "No, keep planning" : "Deny"}
          </Button>
          {part.suggestions.length > 0 && (
            <Button type="button" variant="outline" onClick={() => onRespond({ decision: "allow_always", updatedInput })}>
              {plan !== undefined ? "Yes, and auto-accept edits" : "Allow always"}
            </Button>
          )}
          <Button type="button" onClick={() => onRespond({ decision: "allow", updatedInput })}>
            {plan !== undefined ? "Yes, manually approve edits" : "Allow once"}
          </Button>
        </div>
      </div>
    </form>
  );
}
