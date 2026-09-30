// Permission panel (replaces the prompt box) and its timeline marker (docs/spec.md "Permission bridge").
import { useState, type FormEvent } from "react";
import type { PermissionUpdate } from "@claude-ui/protocol";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldXIcon } from "lucide-react";
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

export function PermissionPanel({ part, onRespond }: { part: PermissionRequest; onRespond: (a: PermissionAnswer) => void }) {
  const [feedback, setFeedback] = useState("");
  const [draft, setDraft] = useState(() => proposed(part));
  const updatedInput = draft === undefined ? undefined : editedInput(part, draft);
  const deny = (e: FormEvent) => {
    e.preventDefault();
    onRespond({ decision: "deny", message: feedback.trim() || undefined });
  };
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-amber-500/50 p-3 text-sm" data-testid="permission-panel" aria-label="Permission request">
      <p className="font-medium">{part.title ?? `Claude wants to use ${part.tool}`}</p>
      {draft === undefined ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">{inputText(part.input)}</pre>
      ) : (
        <>
          <div className="max-h-64 overflow-auto">
            <InputDiff tool={part.tool} input={updatedInput ?? part.input} />
          </div>
          <textarea
            className="max-h-48 min-h-20 rounded-md border bg-transparent p-2 font-mono text-xs"
            aria-label="Proposed new content"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </>
      )}
      <Button className="justify-start" variant="outline" onClick={() => onRespond({ decision: "allow", updatedInput })}>
        Yes
      </Button>
      {/* Like Claude Code: one option that applies every SDK suggestion (e.g. the Bash rule plus its directory). */}
      {part.suggestions.length > 0 && (
        <Button className="justify-start" variant="outline" onClick={() => onRespond({ decision: "allow_always", updatedInput })}>
          <span className="truncate">
            Yes, and don&apos;t ask again for <code className="font-mono">{part.suggestions.map(ruleLabel).join(", ")}</code>
          </span>
        </Button>
      )}
      <form onSubmit={deny} className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1.5"
          placeholder="No, and tell Claude what to do differently"
          aria-label="No, and tell Claude what to do differently"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <Button type="submit" variant="outline">
          No
        </Button>
      </form>
    </section>
  );
}

const DECISION = {
  allow: { label: "Allowed", Icon: ShieldCheckIcon, className: "text-green-600" },
  allow_always: { label: "Always allowed", Icon: ShieldCheckIcon, className: "text-green-600" },
  deny: { label: "Denied", Icon: ShieldXIcon, className: "text-destructive" },
  cancelled: { label: "Cancelled", Icon: ShieldXIcon, className: "text-muted-foreground" },
};

export function PermissionMarker({ part }: { part: PermissionRequest }) {
  const d = part.settled && part.decision ? DECISION[part.decision] : { label: "Waiting for approval", Icon: ShieldAlertIcon, className: "text-amber-600" };
  const rule = part.decision === "allow_always" && part.suggestions.length ? `: ${part.suggestions.map(ruleLabel).join(", ")}` : "";
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs" data-testid="permission-marker" data-settled={part.settled}>
      <d.Icon className={`size-4 shrink-0 ${d.className}`} />
      <span className="truncate">
        {part.tool} · {d.label}
        {rule}
        {part.message ? ` · “${part.message}”` : ""}
      </span>
    </div>
  );
}
