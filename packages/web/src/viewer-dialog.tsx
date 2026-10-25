// Popup viewer: a modal dialog showing a file, a diff, a plan or the Changes view opened from the timeline or the palette
// (docs/spec.md "Session view UX"). Esc or Close closes it; focus is trapped and returns to the control that opened it.
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { EditorView } from "@codemirror/view";
import type { FsMediaResult, FsReadResult } from "@claude-ui/protocol";
import { Columns2Icon, RotateCwIcon, Rows2Icon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { useNarrow } from "@/lib/use-narrow.ts";
import { cn } from "@/lib/utils";
import type { RepoTarget } from "./repos.ts";
import { ChangesPanel, loadStyle, saveStyle, type DiffStyle } from "./changes-panel.tsx";
import type { connect, RequestError } from "./client.ts";
import { sessionDiffChoice } from "./diff-mode.ts";
import { readFailure, mediaKind } from "./files.ts";
import { CodeEditor } from "./files-panel.tsx";
import { shownPrompt } from "./config-dialog.tsx";
import { trapTab } from "./focus-trap.ts";
import { MediaView } from "./media-view.tsx";
import { relPath } from "./paths.ts";
import type { SessionView } from "./store.ts";
import { CwdContext, InputDiff } from "./tool-card.tsx";
import { callPath, type ViewerTarget } from "./viewer.ts";

/** What this dialog shows: a file opens in the file dialog (file-dialog.tsx). */
type PopupTarget = Exclude<ViewerTarget, { kind: "file" }>;

type Client = ReturnType<typeof connect>;
const noop = () => {};

const title = (t: PopupTarget, cwd: string) => (t.kind === "diff" ? relPath(callPath(t.call), cwd) : t.kind === "plan" ? "Plan" : "Changes");

/** `opener`: the element focused when the popup opened; focus returns to it on close, else to the prompt box. */
export function ViewerDialog({
  target,
  opener,
  client,
  cwd,
  view,
  sessionId,
  repo,
  onClose,
  onOpenInEditor,
}: {
  target: PopupTarget | undefined;
  opener?: HTMLElement | null;
  client: Client;
  cwd: string;
  view?: SessionView;
  sessionId?: string;
  /** The repository the git panes show (App, from `git.repos`); see ChangesPanel. */
  repo?: RepoTarget | null;
  onClose: () => void;
  /** Opens `path` in the Files tab (at `line`) and closes the viewer. */
  onOpenInEditor: (path: string, line?: number) => void;
}) {
  // Keep the last target while the close transition runs, so the content does not vanish first.
  const last = useRef(target);
  if (target) last.current = target;
  // Same for the opener: App clears it with the target, and Base UI asks finalFocus after that render.
  const lastOpener = useRef(opener);
  if (target) lastOpener.current = opener;
  const shown = target ?? last.current;
  return (
    <Dialog.Root
      open={!!target}
      onOpenChange={(o, d) => {
        if (o) return;
        // Esc that CodeMirror's search panel already handled (it closes the panel) must not close the dialog.
        if (d.reason === "escape-key" && d.event.defaultPrevented) return d.cancel();
        onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          finalFocus={() => (lastOpener.current?.isConnected ? lastOpener.current : (shownPrompt() ?? true))}
          onKeyDown={trapTab}
          // App shortcuts and Esc (stop turn) skip while an aria-modal dialog shows; Base UI does not set it.
          aria-modal="true"
          data-testid="viewer-dialog"
          data-kind={shown?.kind}
          className="fixed inset-0 z-50 m-auto flex h-[min(100dvh-32px,90dvh)] w-[min(100vw-32px,1200px)] flex-col overflow-hidden rounded-xl bg-card text-foreground shadow-floating outline-none max-sm:h-dvh max-sm:w-full max-sm:rounded-none"
        >
          {shown && (
            <CwdContext value={cwd}>
              <Content target={shown} client={client} cwd={cwd} view={view} sessionId={sessionId} repo={repo} onOpenInEditor={onOpenInEditor} />
            </CwdContext>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Header({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 border-b py-1 pr-2 pl-4">
      <Dialog.Title className="min-w-0 flex-1 truncate font-medium text-[15px] tracking-[-0.13px]">{text}</Dialog.Title>
      {children}
      <DialogClose />
    </div>
  );
}

/** The X of a dialog header. */
export function DialogClose() {
  return (
    <Dialog.Close
      aria-label="Close"
      data-testid="viewer-close"
      className="grid size-7 shrink-0 place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11 pointer-coarse:size-11"
    >
      <XIcon className="size-4" />
    </Dialog.Close>
  );
}

function Content({ target, client, cwd, view, sessionId, repo, onOpenInEditor }: { target: PopupTarget; client: Client; cwd: string; view?: SessionView; sessionId?: string; repo?: RepoTarget | null; onOpenInEditor: (path: string, line?: number) => void }) {
  const text = title(target, cwd);
  switch (target.kind) {
    case "diff":
      return <DiffBody client={client} call={target.call} onOpenInEditor={onOpenInEditor} header={(extra) => <Header text={text}>{extra}</Header>} />;
    case "plan":
      return (
        <>
          <Header text={text} />
          <div tabIndex={0} aria-label="Plan" data-testid="viewer-plan" className="min-h-0 flex-1 overflow-auto px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
            <MessageResponse>{target.plan}</MessageResponse>
          </div>
        </>
      );
    case "changes":
      return (
        <>
          <Header text={text} />
          {view ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ChangesPanel client={client} view={view} cwd={cwd} repo={repo} onOpen={onOpenInEditor} initialChoice={sessionId ? sessionDiffChoice.get(sessionId) : undefined} />
            </div>
          ) : (
            <p className="p-4 text-muted-foreground text-sm">No session.</p>
          )}
        </>
      );
  }
}

type Loaded = { kind: "text"; doc: string } | { kind: "media"; media: FsMediaResult } | { kind: "error"; text: string; notice: boolean };

type HeaderFn = (extra: React.ReactNode) => React.ReactNode;

/** Header button: the file in the Files tab (editable, with the tree), at `line` when the viewer shows one. */
function OpenInFiles({ path, line, onOpen }: { path: string; line?: number; onOpen?: (path: string, line?: number) => void }) {
  if (!onOpen) return null;
  return (
    <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => onOpen(path, line)} title="Open in Files tab" aria-label="Open in Files tab" data-testid="viewer-open-editor">
      <SquareArrowOutUpRightIcon />
    </Button>
  );
}

/** The file read-only: CodeMirror, or the media viewer for images, SVG, video and audio. A snapshot at open; Reload re-reads it. */
function FileBody({ client, path, line, header, controls, onOpenInEditor }: { client: Client; path: string; line?: number; header: HeaderFn; controls?: React.ReactNode; onOpenInEditor?: (path: string, line?: number) => void }) {
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>();
  const viewRef = useRef<EditorView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        if (mediaKind(path)) {
          const media = await client.request<FsMediaResult>({ type: "fs.media", path });
          live && setLoaded({ kind: "media", media });
        } else {
          const r = await client.request<FsReadResult>({ type: "fs.read", path });
          live && setLoaded({ kind: "text", doc: r.content });
        }
      } catch (e) {
        live && setLoaded({ kind: "error", ...readFailure(e as RequestError) });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, path, reload]);
  const reloadButton = (
    <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => setReload((n) => n + 1)} title="Reload from disk" aria-label="Reload from disk">
      <RotateCwIcon />
    </Button>
  );
  return (
    <>
      {header(
        <>
          {controls}
          <OpenInFiles path={path} line={line} onOpen={onOpenInEditor} />
          {reloadButton}
        </>,
      )}
      {!loaded ? (
        <p className="p-4 text-muted-foreground text-sm" role="status" data-testid="viewer-loading">
          Loading file…
        </p>
      ) : loaded.kind === "error" ? (
        <p role={loaded.notice ? "status" : "alert"} className="p-4 text-muted-foreground text-sm" data-testid="viewer-error">
          {loaded.text}
        </p>
      ) : loaded.kind === "media" ? (
        <MediaView key={loaded.media.url} path={path} media={loaded.media} />
      ) : (
        <CodeEditor path={path} doc={loaded.doc} readOnly tabbable line={line} viewRef={viewRef} onChange={noop} onSave={noop} onSend={noop} />
      )}
    </>
  );
}

/** The call's diff; a switch shows the current file instead. */
function DiffBody({ client, call, header, onOpenInEditor }: { client: Client; call: Extract<ViewerTarget, { kind: "diff" }>["call"]; header: HeaderFn; onOpenInEditor?: (path: string, line?: number) => void }) {
  const [show, setShow] = useState<"diff" | "file">("diff");
  const [chosen, setChosen] = useState<DiffStyle>(loadStyle);
  const narrow = useNarrow();
  const style: DiffStyle = narrow ? "unified" : chosen;
  const switcher = (
    <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label="View">
      {(["diff", "file"] as const).map((s) => (
        <Button
          key={s}
          size="sm"
          variant="ghost"
          aria-pressed={show === s}
          className={cn("max-md:h-11", show === s && "bg-card shadow-xs hover:bg-card")}
          onClick={() => setShow(s)}
          data-testid={`viewer-show-${s}`}
        >
          {s === "diff" ? "Diff" : "File"}
        </Button>
      ))}
    </div>
  );
  const styles = show === "diff" && !narrow && (
    <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label="Diff view">
      {(["unified", "split"] as const).map((s) => (
        <Button
          key={s}
          size="icon-sm"
          variant="ghost"
          aria-pressed={style === s}
          aria-label={s === "unified" ? "Unified diff" : "Split diff"}
          title={s === "unified" ? "Unified diff" : "Split diff"}
          className={cn(style === s && "bg-card shadow-xs hover:bg-card")}
          onClick={() => (setChosen(s), saveStyle(s))}
          data-testid={`viewer-diff-${s}`}
        >
          {s === "unified" ? <Rows2Icon /> : <Columns2Icon />}
        </Button>
      ))}
    </div>
  );
  if (show === "file") return <FileBody client={client} path={callPath(call)} header={header} controls={switcher} onOpenInEditor={onOpenInEditor} />;
  return (
    <>
      {header(
        <>
          {switcher}
          {styles}
          <OpenInFiles path={callPath(call)} onOpen={onOpenInEditor} />
        </>,
      )}
      <div tabIndex={0} aria-label="Diff" className="min-h-0 flex-1 overflow-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <InputDiff tool={call.tool} input={call.input} diffStyle={style} />
      </div>
    </>
  );
}
