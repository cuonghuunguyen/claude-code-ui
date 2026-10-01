// Prompt box toolbar (OpenCode prompt input v2): attach, model, effort, permission mode; send / stop on the right.
import { useRef, type ReactNode } from "react";
import { ArrowUpIcon, BrainIcon, FilePenIcon, ListTodoIcon, LoaderCircleIcon, MessageCircleQuestionIcon, PlusIcon, ShieldAlertIcon, ShieldIcon, SquareIcon } from "lucide-react";
import type { Effort, ModelInfo, PermissionMode } from "@claude-ui/protocol";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Claude Code's names for the modes; `short` fits the toolbar on a phone. */
export const MODE_LABEL: Record<PermissionMode, { label: string; short: string; Icon: typeof ShieldIcon }> = {
  default: { label: "Ask before edits", short: "Ask", Icon: ShieldIcon },
  acceptEdits: { label: "Edit automatically", short: "Edits", Icon: FilePenIcon },
  plan: { label: "Plan mode", short: "Plan", Icon: ListTodoIcon },
  bypassPermissions: { label: "Bypass permissions", short: "Bypass", Icon: ShieldAlertIcon },
  dontAsk: { label: "Don't ask", short: "Don't ask", Icon: ShieldIcon },
  auto: { label: "Auto", short: "Auto", Icon: ShieldIcon },
};

const EFFORT_LABEL: Record<Effort, string> = { default: "Default", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** Shift+Tab: the next mode in Claude Code's order, wrapping around. */
export const nextMode = (modes: PermissionMode[], mode: PermissionMode) => modes[(modes.indexOf(mode) + 1) % modes.length] ?? mode;

/** The model's effort levels plus "default"; none when the model does not support effort (the chooser is hidden). */
export function effortOptions(models: ModelInfo[], model: string): Effort[] {
  const m = models.find((x) => x.value === model);
  return m?.supportsEffort && m.supportedEffortLevels?.length ? ["default", ...m.supportedEffortLevels] : [];
}

// OpenCode ghost-muted control: 28px desktop, 44px on touch screens. `!`: SelectTrigger's data-[size] height has higher specificity.
const GHOST =
  "h-7! cursor-pointer rounded-md border-0 bg-transparent px-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground focus-visible:ring-2 pointer-coarse:h-11! dark:bg-transparent";

function Chooser<T extends string>({
  label,
  value,
  items,
  onChange,
  icon,
  testId,
  className = "",
}: {
  label: string;
  value: T;
  items: { value: T; label: string; trigger?: ReactNode; description?: string }[];
  onChange: (v: T) => void;
  icon?: ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <Select items={items} value={value} onValueChange={(v) => v !== null && v !== value && onChange(v as T)}>
      <SelectTrigger aria-label={label} title={`${label}: ${items.find((i) => i.value === value)?.label ?? value}`} data-testid={testId} className={`${GHOST} min-w-0 ${className}`}>
        {icon}
        <SelectValue className="truncate">{(v: T) => items.find((i) => i.value === v)?.trigger ?? items.find((i) => i.value === v)?.label ?? v}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} side="top" align="start" className="w-auto min-w-44">
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value} title={i.description} className="pointer-coarse:py-2.5">
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PromptToolbar(props: {
  models: ModelInfo[];
  model: string;
  onModel: (model: string) => void;
  effort: Effort;
  onEffort: (effort: Effort) => void;
  mode: PermissionMode;
  modes: PermissionMode[];
  onMode: (mode: PermissionMode) => void;
  onAttach: (files: File[]) => void;
  /** What the send button shows: the session state, or `disconnected` while the daemon is unreachable. */
  state: SendState;
  /** Text or images are in the prompt box: idle it sends, during a turn it steers. */
  hasInput: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  // Keep the current value selectable while the list loads or if it is not in the list.
  const models = props.models.some((m) => m.value === props.model) ? props.models : [{ value: props.model, displayName: props.model, description: "" }, ...props.models];
  const efforts = effortOptions(props.models, props.model);
  const modes = props.modes.includes(props.mode) ? props.modes : [props.mode, ...props.modes];
  const Mode = MODE_LABEL[props.mode].Icon;
  return (
    <div className="flex items-end gap-1 px-2 py-2 pointer-coarse:py-1" data-testid="prompt-toolbar">
      {/* flex-wrap: on a narrow screen a chooser moves to the next row at its full width; nothing shrinks away the model name. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 pointer-coarse:gap-2">
        <button
          type="button"
          aria-label="Add images and files"
          title="Add images and files"
          data-testid="attach"
          className={`${GHOST} flex shrink-0 items-center justify-center px-0 pointer-coarse:w-11 w-7`}
          onClick={() => file.current?.click()}
        >
          <PlusIcon className="size-4" />
        </button>
        {/* No `accept`: any file; on a phone this opens the native picker (camera, photos, files). */}
        <input
          ref={file}
          type="file"
          multiple
          hidden
          data-testid="attach-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            if (files.length) props.onAttach(files);
          }}
        />
        <Chooser
          label="Permission mode (Shift+Tab)"
          testId="mode-select"
          value={props.mode}
          onChange={props.onMode}
          icon={<Mode className="size-4" />}
          items={modes.map((m) => ({ value: m, label: MODE_LABEL[m].label, trigger: <span><span className="sm:hidden">{MODE_LABEL[m].short}</span><span className="hidden sm:inline">{MODE_LABEL[m].label}</span></span> }))}
          className="shrink-0"
        />
        <Chooser
          label="Model"
          testId="session-model"
          value={props.model}
          onChange={props.onModel}
          items={models.map((m) => ({ value: m.value, label: m.displayName, description: m.description }))}
          className="max-w-55"
        />
        {efforts.length > 0 && (
          <Chooser
            label="Thinking effort"
            testId="effort-select"
            value={efforts.includes(props.effort) ? props.effort : "default"}
            onChange={props.onEffort}
            icon={<BrainIcon className="size-4" />}
            items={efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))}
            className="shrink-0"
          />
        )}
      </div>
      <SendButton state={props.state} hasInput={props.hasInput} onSend={props.onSend} onStop={props.onStop} />
    </div>
  );
}

export type SendState = "idle" | "running" | "needs_input" | "disconnected";

const SEND_BASE =
  "relative flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md shadow-sm focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:size-11";

/** OpenCode send/stop button plus the session state: spinner while running, warning color while Claude waits for an answer. */
function SendButton({ state, hasInput, onSend, onStop }: { state: SendState; hasInput: boolean; onSend: () => void; onStop: () => void }) {
  const busy = state === "running" || state === "needs_input";
  const steer = busy && hasInput;
  const [label, key] =
    state === "disconnected"
      ? ["Disconnected from the daemon", ""]
      : state === "idle"
        ? ["Send", " (Enter)"]
        : [`${state === "running" ? "Claude is working" : "Claude needs your input"}. ${steer ? "Steer" : "Stop"}`, steer ? " (Enter)" : " (Esc)"];
  const Icon = busy && !steer ? SquareIcon : ArrowUpIcon;
  return (
    <button
      type="button"
      aria-label={label}
      title={label + key}
      data-state={state}
      data-testid={busy && !steer ? "toolbar-stop" : "send"}
      disabled={state === "disconnected" || (state === "idle" && !hasInput)}
      className={`${SEND_BASE} ${state === "needs_input" ? "bg-warning text-background motion-safe:animate-pulse" : "bg-primary text-primary-foreground"}`}
      onClick={steer || state === "idle" ? onSend : onStop}
    >
      {state === "running" && <LoaderCircleIcon aria-hidden className="absolute size-5.5 animate-spin opacity-60 motion-reduce:animate-none pointer-coarse:size-8" />}
      {state === "needs_input" && !steer ? (
        <MessageCircleQuestionIcon aria-hidden className="size-4" />
      ) : (
        <Icon aria-hidden className={Icon === SquareIcon ? "size-2.5 fill-current" : state === "running" ? "size-3" : "size-4"} />
      )}
    </button>
  );
}
