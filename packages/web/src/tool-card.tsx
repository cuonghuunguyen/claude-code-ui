// Tool cards, context groups and thinking blocks (docs/spec.md "Message model", "Session view UX").
import { isPromptImage, type Part, type ToolStatus } from "@claude-ui/protocol";
import { useMediaSrc } from "./media.ts";
import { MediaPlaceholder } from "./media-notice.tsx";
import type { FileDiffOptions } from "@pierre/diffs";
import { MultiFileDiff } from "@pierre/diffs/react";
import { useColorTheme, useDark } from "./theme.ts";
import { DIFF_THEMES, diffThemes } from "./code-palette.ts";
import "./code-theme.ts"; // registers the diff themes before any diff renders
import type { ToolUIPart } from "ai";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { SendToBackIcon, Maximize2Icon, PanelsTopLeftIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Tool, ToolChevron, ToolContent, ToolHeader, ToolInput, ToolOutput, ToolStatusMark, toolRowClass } from "@/components/ai-elements/tool";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Mark, statusText } from "./todo-dock.tsx";
import { parseAnsi } from "./ansi.ts";
import type { ToolCall } from "./store.ts";
import { relPath } from "./paths.ts";
import { specOf } from "./keymap.ts";
import { keyText } from "./shortcuts.ts";
import { fileSize } from "./files.ts";
import { BackgroundShellContext, PlanTabContext, ViewerContext, cardTarget, type OpenViewer, type ViewerTarget } from "./viewer.ts";
import { ArtifactPreview } from "./artifact-preview.tsx";
import { ARTIFACT_TOOLS, artifactPreviewable, artifactSummary, artifactTitle, claudeUrl, diffStats, editFiles, filePath, isClaudeUrl, readRange, todoItems, todoSummary, toolSummary } from "./tools.ts";
import { t as tr, useT } from "./i18n.ts";

type ToolResult = Extract<Part, { type: "tool_result" }>;

const STATE: Record<ToolStatus, ToolUIPart["state"]> = {
  pending: "input-streaming",
  running: "input-available",
  done: "output-available",
  error: "output-error",
  denied: "output-denied",
  stopped: "output-denied",
};
/** Labels that differ from the state's own. */
const label = (status: ToolStatus) => (status === "stopped" ? tr("session.toolCard.stopped") : undefined);

/** Base64 content block of a tool result (Read of an image or PDF): the data is not text, so cards show it as an image or one line. */
const mediaBlock = (b: unknown) => {
  const { type, source } = (b ?? {}) as { type?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown; bytes?: unknown } };
  if (type !== "image" && type !== "document") return;
  const media = typeof source?.media_type === "string" ? source.media_type : type;
  // `omitted`: a snapshot or page left the data out (GH-274); it loads on demand.
  if (source?.type === "omitted" && typeof source.bytes === "number") return { media, size: fileSize(source.bytes), src: undefined, omitted: true };
  if (typeof source?.data !== "string") return;
  return { media, size: fileSize(Math.floor((source.data.length * 3) / 4)), src: type === "image" && isPromptImage(media) ? `data:${media};base64,${source.data}` : undefined, omitted: false };
};
const note = (b: unknown) => {
  const m = mediaBlock(b);
  return m && `[${m.media}, ${m.size}]`;
};
/** The output with each base64 block replaced by its one-line note. */
const redact = (output: unknown) => (Array.isArray(output) ? output.map((b) => note(b) ?? b) : output);

// The CLI wraps a tool's error message in <tool_use_error> tags.
const text = (output: unknown) =>
  typeof output === "string" ? output.replace(/^<tool_use_error>([\s\S]*?)\s*<\/tool_use_error>$/, "$1") : JSON.stringify(redact(output), null, 2);

// themeType follows the app theme (`.dark` on <html>), not the OS: "system" would ignore the theme toggle.
export const DIFF_OPTIONS: FileDiffOptions<undefined, undefined> = {
  diffStyle: "unified",
  theme: DIFF_THEMES,
  overflow: "wrap",
};

/** The session cwd: card headers and diff headers show file paths relative to it. */
export const CwdContext = createContext("");

// ponytail: ids of cards the user expanded, kept outside React so a remount (a Read merging into a context group,
// a tab switch, an item leaving the rendered window) keeps the state; never pruned, only expanded ids land here.
const expanded = new Set<string>();

/** Per-card expand state, collapsed by default (docs/spec.md "Session view UX"); `force` holds the card open. */
export function useExpanded(id: string, force = false) {
  const [open, setOpen] = useState(() => expanded.has(id));
  const onOpenChange = (next: boolean) => {
    if (next) expanded.add(id);
    else expanded.delete(id);
    setOpen(next);
  };
  return { open: open || force, onOpenChange };
}

/** `awaiting`: the call waits for a permission answer, so the card is held open; except an Edit/Write with a diff,
 *  which stays collapsed because the permission panel shows that diff (GH-86); a click still expands it. */
export function ToolCard({ call, result, awaiting, plan }: { call: ToolCall; result?: ToolResult; awaiting?: boolean; /** An ExitPlanMode call's plan (planOfPart); absent: its `input.plan`. */ plan?: string }) {
  const t = useT();
  const range = call.tool === "Read" ? readRange(call.input, result?.output) : "";
  const stats = useMemo(() => diffStats(call.tool, call.input), [call.tool, call.input]);
  const artifact = ARTIFACT_TOOLS.has(call.tool);
  // An Artifact publish names the long scratchpad file_path: the row shows the title instead.
  const todos = call.tool === "TodoWrite" ? todoItems(call.input) : [];
  const path = artifact ? "" : field(call.input, "file_path") || field(call.input, "notebook_path");
  const openViewer = use(ViewerContext);
  const cwd = use(CwdContext);
  const target = openViewer && cardTarget(call, plan);
  const showPlan = use(PlanTabContext);
  const toBackground = use(BackgroundShellContext);
  const canBackground = !!toBackground && call.tool === "Bash" && call.status === "running" && call.shell === "foreground";
  const [moving, setMoving] = useState<{ error?: string }>();
  const decided = call.coordinator && (call.coordinator.decision === "allow" ? t("session.toolCard.approvedByCoordinator") : t("session.toolCard.deniedByCoordinator"));
  const header = (
    <ToolHeader
      className={target || canBackground ? "min-w-0 flex-1" : undefined}
      type="dynamic-tool"
      toolName={call.tool}
      state={awaiting ? "approval-requested" : STATE[call.status]}
      statusLabel={awaiting ? undefined : label(call.status)}
      // Next to the tool name, which is never truncated like the summary.
      title={call.editedByUser ? t("session.toolCard.editedByYou", { tool: call.tool }) : decided ? t("session.toolCard.titleDecided", { tool: call.tool, decision: decided }) : undefined}
      summary={path ? <FileSummary path={path} range={range} /> : todos.length ? todoSummary(todos) : artifact ? artifactSummary(call.tool, call.input) : toolSummary(call.input)}
      tooltip={path || undefined}
      meta={
        stats && (
          <span data-testid="diff-stats" className="font-mono text-xs">
            <span className="text-success">+{stats.added}</span>
            <span className="ml-1 text-destructive">-{stats.removed}</span>
          </span>
        )
      }
    />
  );
  return (
    <Tool data-testid="tool-card" data-status={call.status} {...useExpanded(call.id, awaiting && !stats)}>
      {target || canBackground ? (
        <div className="group/head flex items-center gap-1">
          {header}
          {canBackground && (
            <BackgroundButton
              pending={!!moving && !moving.error}
              onClick={() => {
                setMoving({});
                toBackground!(call.toolUseId).catch((e: Error) => setMoving({ error: e.message }));
              }}
            />
          )}
          {call.tool === "ExitPlanMode" && target?.kind === "plan" && showPlan && <PlanTabButton onOpen={showPlan} />}
          {target && <OpenButton target={target} onOpen={openViewer!} label={openLabel(target, stats, cwd)} />}
        </div>
      ) : (
        header
      )}
      {canBackground && moving?.error && (
        <p role="alert" data-testid="run-in-background-error" className="px-3 pb-2 text-xs text-destructive">
          {t("session.toolCard.backgroundFailed", { error: moving.error })}
        </p>
      )}
      <ToolContent>
        {decided && (
          // Orchestration: the coordinator's reason, as plain text (worker-influenced, never markdown).
          <p data-testid="coordinator-decision" className="px-3 pt-2 text-xs text-muted-foreground">
            <span className="font-medium">{decided}:</span> {call.coordinator!.reason}
          </p>
        )}
        <ToolBody call={call} result={result} plan={plan} />
      </ToolContent>
    </Tool>
  );
}

const openLabel = (target: ViewerTarget, stats: { added: number; removed: number } | undefined, cwd: string) => {
  if (target.kind === "plan") return tr("session.permission.openPlanPopup");
  const name = target.kind === "file" ? filePath(target.path, cwd).name : target.kind === "diff" ? filePath(field(target.call.input, "file_path"), cwd).name : "";
  return target.kind === "diff" && stats ? tr("session.toolCard.openDiff", { name, added: stats.added, removed: stats.removed }) : target.kind === "file" ? tr("session.toolCard.openFile", { name }) : tr("session.toolCard.openPopup", { name });
};

const OPEN_CLASS =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info group-hover/head:opacity-100 group-has-[[data-panel-open]]/head:opacity-100 max-md:size-11 pointer-coarse:size-11 pointer-coarse:opacity-100";

/** Run in background (GH-440): always visible while the command runs (a transient action), 44 px below md. */
export function BackgroundButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  const t = useT();
  const keys = keyText(specOf("shell.background"));
  return (
    <button
      type="button"
      aria-label={t("session.toolCard.background")}
      title={keys ? t("session.toolCard.backgroundKeys", { keys }) : t("session.toolCard.background")}
      data-testid="run-in-background"
      data-command="shell.background"
      disabled={pending}
      aria-busy={pending}
      onClick={onClick}
      className={cn(OPEN_CLASS.replace("opacity-0 ", ""), "disabled:cursor-default disabled:opacity-50")}
    >
      <SendToBackIcon aria-hidden className="size-4" />
    </button>
  );
}

/** "Open in tab" of the plan card (GH-395): same reveal rules as OpenButton. */
function PlanTabButton({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <button type="button" aria-label={t("session.permission.openPlanTab")} title={t("session.permission.openTab")} data-testid="plan-open-tab" onClick={onOpen} className={OPEN_CLASS}>
      <PanelsTopLeftIcon aria-hidden className="size-4" />
    </button>
  );
}

/** Open-in-popup button right of a card header: hover, keyboard focus, open card, always on touch (like the chevron). */
function OpenButton({ target, onOpen, label }: { target: ViewerTarget; onOpen: OpenViewer; label: string }) {
  const t = useT();
  return (
    <button
      type="button"
      aria-label={label}
      title={target.kind === "file" ? t("session.toolCard.openFileTitle") : t("session.permission.openPopup")}
      data-testid="viewer-open"
      onClick={(e) => onOpen(target, e.currentTarget)}
      className={OPEN_CLASS}
    >
      <Maximize2Icon aria-hidden className="size-4" />
    </button>
  );
}

const field = (input: unknown, key: string) => {
  const v = (input as Record<string, unknown> | null)?.[key];
  return typeof v === "string" ? v : "";
};

/** File name, then its directory relative to cwd; a narrow row cuts the directory from the left first, then the name; the range stays. */
function FileSummary({ path, range }: { path: string; range: string }) {
  const { name, dir } = filePath(path, use(CwdContext));
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <span data-testid="file-name" className="min-w-0 truncate">
        {name}
      </span>
      {dir && (
        <span data-testid="file-dir" className="min-w-0 shrink-[1000] truncate [direction:rtl]">
          <bdi>{dir}</bdi>
        </span>
      )}
      {range && (
        <span data-testid="read-range" className="shrink-0">
          · {range}
        </span>
      )}
    </span>
  );
}

/** Card body by tool type; tools without a purpose-built body get the generic JSON view. */
/** The image of a Read result: inline, or loaded with session.media when the snapshot left it out; PDFs and other types show only the caption. */
function ReadImage({ partId, index, m, alt }: { partId: string; index: number; m: { media: string; src?: string; omitted: boolean }; alt: string }) {
  const loads = m.omitted && isPromptImage(m.media);
  const { src, failed, retry } = useMediaSrc(partId, index, loads, m.src);
  if (src) return <img src={src} alt={alt} className="max-h-80 max-w-full rounded-md border object-contain" />;
  // The size of the image is not known (only its bytes): a fixed box about as tall as a typical screenshot.
  return loads ? <MediaPlaceholder failed={failed} retry={retry} label={alt} className="h-52 w-full max-w-sm" /> : null;
}

export function ToolBody({ call, result, plan: folded, tail }: { call: ToolCall; result?: ToolResult; /** An ExitPlanMode call's plan (planOfPart). */ plan?: string; /** The shells list: the output's cut keeps its last lines. */ tail?: boolean }) {
  const t = useT();
  const output = result && <Lines id={call.id} text={text(result.output)} error={result.isError} plain={call.tool === "Bash"} tail={tail} />;
  switch (call.tool) {
    case "Bash":
      // OpenCode shell anatomy: `$ command` and the output as plain text in one bordered box.
      return (
        <div className="max-h-60 space-y-2 overflow-auto rounded-md border p-3">
          <pre data-testid="bash-command" className="whitespace-pre-wrap font-mono text-xs">
            <span className="select-none text-muted-foreground">$ </span>
            {field(call.input, "command")}
          </pre>
          {output}
        </div>
      );
    case "Read": {
      // The index is the block's position in the output: session.media names the payload by it.
      const media = Array.isArray(result?.output) ? result.output.flatMap((b, index) => { const m = mediaBlock(b); return m ? [{ ...m, index }] : []; }) : [];
      return (
        <div className="space-y-2">
          <div data-testid="read-path" className="font-mono text-xs">
            {field(call.input, "file_path")}
            <span className="text-muted-foreground"> {readRange(call.input, result?.output)}</span>
          </div>
          {media.length && !result?.isError ? (
            media.map((m, i) => (
              <figure key={i} className="space-y-1" data-testid="read-media">
                <ReadImage partId={result!.id} index={m.index} m={m} alt={field(call.input, "file_path")} />
                <figcaption className="text-muted-foreground text-xs">{`${m.media}, ${m.size}`}</figcaption>
              </figure>
            ))
          ) : (
            output
          )}
        </div>
      );
    }
    case "Grep":
    case "Glob": {
      const scope = [field(call.input, "path"), field(call.input, "glob")].filter(Boolean).join(" ");
      return (
        <div className="space-y-2">
          <div data-testid="search-pattern" className="font-mono text-xs">
            {field(call.input, "pattern")}
            {scope && <span className="text-muted-foreground"> {t("session.toolCard.searchIn", { scope })}</span>}
          </div>
          {output}
        </div>
      );
    }
    case "Edit":
    case "Write":
      return <EditDiff call={call} result={result} />;
    case "TodoWrite": {
      // The list the call wrote, still readable after the turn (the pinned dock only shows while it runs).
      const items = todoItems(call.input);
      if (!items.length) break;
      return (
        <ul data-testid="todo-card-list" className="space-y-1.5">
          {items.map((item, i) => (
            <li
              key={i}
              data-testid="todo-card-item"
              data-status={item.status}
              className={cn(
                "flex gap-2 break-words text-[14px]/[1.3]",
                item.status === "completed" ? "text-muted-foreground line-through" : "text-foreground",
                item.status === "in_progress" && "font-medium",
              )}
            >
              <Mark status={item.status} />
              <span className="min-w-0">
                <span className="sr-only">{statusText[item.status]}: </span>
                {item.content}
              </span>
            </li>
          ))}
        </ul>
      );
    }
    case "Artifact":
    case "ArtifactComments":
    case "ArtifactData":
      return <ArtifactBody call={call} result={result} />;
    case "ExitPlanMode": {
      // The plan as the approval panel shows it; the JSON view until the input has streamed in.
      const plan = folded || field(call.input, "plan");
      if (!plan) break;
      return (
        <div className="space-y-2">
          <div className="max-h-80 overflow-auto rounded-md border p-3" data-testid="plan">
            <MessageResponse>{plan}</MessageResponse>
          </div>
          {result?.isError && <ToolOutput output={undefined} errorText={text(result.output)} />}
        </div>
      );
    }
  }
  return (
    <>
      <ToolInput input={call.input} />
      {result && (
        <ToolOutput output={result.isError ? undefined : redact(result.output)} errorText={result.isError ? text(result.output) : undefined} />
      )}
    </>
  );
}

/** A claude.ai artifact link opening in a new tab; any other URL is plain text (a result is not trusted). */
function ArtifactLink({ url }: { url: string }) {
  const t = useT();
  if (!isClaudeUrl(url)) return <span className="break-all font-mono text-xs">{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title={t("session.toolCard.opensNewTab", { url })} className="inline-flex min-h-11 items-center break-all text-foreground text-xs underline md:min-h-0">
      {url}
    </a>
  );
}

/** Bodies of Artifact, ArtifactComments and ArtifactData calls: summary fields from the input, the result as plain text
 *  (comment text is written by viewers: never markdown or HTML). Result formats are unverified, so nothing is parsed
 *  beyond the claude.ai URL; the result text is always shown when there is no better field. */
function ArtifactBody({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const t = useT();
  const out = text(result?.output);
  const failed = result?.isError === true;
  const output = result && <Lines id={call.id} text={out} error={failed} wrap />;
  const action = field(call.input, "action") || (call.tool === "Artifact" ? "publish" : "");
  const url = field(call.input, "url");
  if (call.tool === "ArtifactData") {
    const data = (call.input as Record<string, unknown> | null)?.data ?? (call.input as Record<string, unknown> | null)?.writes;
    return (
      <div className="space-y-2">
        <div data-testid="artifact-summary" className="font-mono text-xs">
          {artifactSummary(call.tool, call.input)}
        </div>
        {data !== undefined && <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2 font-mono text-xs">{JSON.stringify(data, null, 2)}</pre>}
        {output}
      </div>
    );
  }
  if (call.tool === "ArtifactComments") {
    const thread = field(call.input, "thread_id");
    // A resolve of a thread not activated for Claude returns guidance without an error: only a result that says so confirms it.
    const resolved = result !== undefined && !failed && /resolved/i.test(out) && !/activat/i.test(out);
    return (
      <div className="space-y-2">
        {url && <ArtifactLink url={url} />}
        {action === "reply" && (
          <div data-testid="artifact-reply" className="space-y-1">
            {thread && <div className="text-muted-foreground text-xs">{t("session.toolCard.replyThread", { thread })}</div>}
            <p className="whitespace-pre-wrap break-words rounded-md border p-2 text-sm">{field(call.input, "text")}</p>
          </div>
        )}
        {action === "resolve" && <div className="text-xs">{!result ? t("session.toolCard.resolving", { thread }) : resolved ? t("session.toolCard.resolved", { thread }) : ""}</div>}
        {output}
      </div>
    );
  }
  if (action === "publish") {
    // The input URL (update in place) first, else the one in the result; none for a failed call.
    const link = failed ? undefined : isClaudeUrl(url) ? url : claudeUrl(out);
    const title = field(call.input, "title");
    const description = field(call.input, "description");
    const file = field(call.input, "file_path");
    return (
      <div className="space-y-2">
        <div data-testid="artifact-publish" className="space-y-1">
          {title && <div className="font-medium text-sm">{title}</div>}
          {description && <p className="whitespace-pre-wrap text-muted-foreground text-xs">{description}</p>}
          {link && <ArtifactLink url={link} />}
          {file && (
            <div title={file} className="break-all font-mono text-muted-foreground text-xs">
              {file}
            </div>
          )}
          {artifactPreviewable(call) && <ArtifactPreview partId={call.id} title={artifactTitle(call) || file} />}
        </div>
        {output}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {isClaudeUrl(url) && <ArtifactLink url={url} />}
      {output}
    </div>
  );
}

/** Unified diff built from the Edit/Write input; the JSON parameters until the input has streamed in. The result text only on error. */
function EditDiff({ call, result }: { call: ToolCall; result?: ToolResult }) {
  return (
    <>
      <InputDiff tool={call.tool} input={call.input} fallback={<ToolInput input={call.input} />} />
      {result?.isError && <ToolOutput output={undefined} errorText={text(result.output)} />}
    </>
  );
}

/** The Edit/Write diff of a tool input; `fallback` while the input is incomplete. Also used by the permission panel. */
export function InputDiff({
  tool,
  input,
  fallback,
  diffStyle = "unified",
  fileHeader = true,
}: {
  tool: string;
  input: unknown;
  fallback?: ReactNode;
  diffStyle?: "unified" | "split";
  /** False under a header of the caller's own (changes tab). */
  fileHeader?: boolean;
}) {
  const cwd = use(CwdContext);
  const files = useMemo(() => {
    const f = editFiles(tool, input);
    if (!f) return undefined;
    // File header (icon, path, +N -N) like OpenCode's diff card; the path relative to cwd.
    const name = relPath(f.newFile.name, cwd);
    return { oldFile: { ...f.oldFile, name }, newFile: { ...f.newFile, name } };
  }, [tool, input, cwd]);
  const dark = useDark();
  const colorTheme = useColorTheme();
  const options = useMemo(
    () => ({ ...DIFF_OPTIONS, theme: diffThemes(colorTheme), diffStyle, themeType: dark ? ("dark" as const) : ("light" as const), disableFileHeader: !fileHeader }),
    [dark, colorTheme, diffStyle, fileHeader],
  );
  if (!files) return fallback;
  return (
    <div className="overflow-hidden rounded-md border text-xs" data-testid="edit-diff">
      <MultiFileDiff oldFile={files.oldFile} newFile={files.newFile} options={options} />
    </div>
  );
}

const MAX_LINES = 20;

/** Monospace output, cut to MAX_LINES lines until expanded. `plain`: Bash output, ANSI colors and no box of its own. `tail`: the cut keeps the last lines (live shell output). */
function Lines({ id, text, error, plain = false, wrap = false, tail = false }: { id: string; text: string; error: boolean; plain?: boolean; wrap?: boolean; tail?: boolean }) {
  const t = useT();
  const { open: all, onOpenChange: setAll } = useExpanded(`lines:${id}`);
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = all ? lines.join("\n") : (tail ? lines.slice(-MAX_LINES) : lines.slice(0, MAX_LINES)).join("\n");
  return (
    <div>
      <pre
        className={cn(
          "overflow-x-auto font-mono text-xs",
          (error && !plain) || wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          error && "text-destructive",
          !plain && "rounded-md p-2",
          !plain && (error ? "bg-destructive/10" : "bg-muted/50"),
        )}
      >
        {plain
          ? parseAnsi(shown).map((seg, i) => (
              <span key={i} style={seg.style}>
                {seg.text}
              </span>
            ))
          : shown}
      </pre>
      {lines.length > MAX_LINES && (
        <button type="button" className="mt-1 text-muted-foreground text-xs hover:underline" onClick={() => setAll(!all)}>
          {all ? t("session.toolCard.showLess") : t("session.toolCard.showAll", { count: lines.length })}
        </button>
      )}
    </div>
  );
}

/** Consecutive read/search calls as one row: "Exploring"/"Explored" and the counts (OpenCode context group). */
export function ContextGroup({
  calls,
  result,
  awaiting = () => false,
}: {
  calls: ToolCall[];
  result: (call: ToolCall) => ToolResult | undefined;
  awaiting?: (call: ToolCall) => boolean;
}) {
  const t = useT();
  const failed = calls.some((c) => c.status === "error" || c.status === "denied");
  const busy = calls.some((c) => c.status === "pending" || c.status === "running");
  const reads = calls.filter((c) => c.tool === "Read").length;
  const counts = [reads ? t("session.toolCard.reads", { count: reads }) : "", calls.length - reads ? t("session.toolCard.searches", { count: calls.length - reads }) : ""].filter(Boolean).join(", ");
  return (
    <Tool data-testid="context-group" {...useExpanded(`context:${calls[0]!.id}`, calls.some(awaiting))}>
      <CollapsibleTrigger className={toolRowClass}>
        {busy ? <Shimmer as="span" className="font-medium">{t("session.toolCard.exploring")}</Shimmer> : <span className="font-medium">{t("session.toolCard.explored")}</span>}
        <span className="truncate text-muted-foreground">{counts}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {failed && <ToolStatusMark state="output-error" />}
          <ToolChevron />
        </span>
      </CollapsibleTrigger>
      <ToolContent className="space-y-1 pl-3">
        {calls.map((c) => (
          <ToolCard key={c.id} call={c} result={result(c)} awaiting={awaiting(c)} />
        ))}
      </ToolContent>
    </Tool>
  );
}

type Subagent = Extract<Part, { type: "subagent" }>;

/** A subagent run: header with description and status; `children` is its nested timeline. `awaiting`: a child call waits for a permission answer. */
/** `onOpen`: opens the run's subagent view (Open icon right of the header). */
export function SubagentGroup({ part, result, awaiting, onOpen, children }: { part: Subagent; result?: ToolResult; awaiting?: boolean; onOpen?: () => void; children: ReactNode }) {
  const t = useT();
  return (
    <Tool data-testid="subagent" data-status={part.status} {...useExpanded(part.id, awaiting)}>
      <div className="flex items-center gap-1">
        <ToolHeader
          type="dynamic-tool"
          toolName="Agent"
          state={STATE[part.status]}
          statusLabel={label(part.status)}
          summary={part.description}
          className="min-w-0 flex-1"
        />
        {onOpen && (
          <button
            type="button"
            aria-label={t("session.toolCard.openSubagentLabel", { description: part.description })}
            title={t("session.toolCard.openSubagent")}
            data-testid="subagent-open"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:size-11"
            onClick={onOpen}
          >
            <SquareArrowOutUpRightIcon aria-hidden className="size-4" />
          </button>
        )}
      </div>
      <ToolContent className="space-y-2 border-l-2 pl-3">
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
