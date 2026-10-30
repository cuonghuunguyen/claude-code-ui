// The Artifacts pane (GH-176, docs/spec.md "Pane layout"): the artifacts a session published, newest first, with the selected one previewed. In a dock or as a main-area tab.
import { memo, useMemo, useRef, useSyncExternalStore, useEffect, type KeyboardEvent } from "react";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useContainerWidth } from "@/lib/use-container-width";
import { ArtifactConnectedContext, ArtifactFrame, ArtifactPreviewContext, type ArtifactPreviewLoader } from "./artifact-preview.tsx";
import { sessionArtifacts, type ArtifactRow } from "./artifacts.ts";
import { useT } from "./i18n.ts";
import { timeAgo } from "./sessions.ts";
import type { SessionView } from "./store.ts";
import { isClaudeUrl } from "./tools.ts";

const WIDE = 720;
// The selected row per session, outside React so "Move to Artifacts" (App) can preselect without App state.
// `detail`: below 720 px the preview shows instead of the list.
type Pick = { partId: string; detail: boolean };
const picked = new Map<string, Pick>();
const listeners = new Set<() => void>();
export function selectArtifact(owner: string, partId: string, detail = false): void {
  picked.set(owner, { partId, detail });
  listeners.forEach((l) => l());
}
/** A forgotten (deleted or unknown) session keeps no selection. */
export function forgetArtifactSelection(owner: string): void {
  if (picked.delete(owner)) listeners.forEach((l) => l());
}
/** Tests: a fresh start. */
export function resetArtifactSelection(): void {
  picked.clear();
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

type Props = {
  view: SessionView | undefined;
  /** The session the pane shows (selection key). */
  owner: string;
  /** Main tab: "Artifacts · <title>"; dock: "Artifacts". */
  label: string;
  /** Preview loader bound to `owner`. */
  load: ArtifactPreviewLoader;
  connected: boolean;
  onOpenTab: (partId: string) => void;
  /** Loads the Artifact publishes older than the loaded page (App sends session.artifacts once per boundary). */
  requestOlder: () => void;
  /** Its tab or dock pane is not the selected one: no preview is requested or mounted. */
  hidden?: boolean;
  /** The session's subscribe failed: no view will come on its own. */
  failed?: boolean;
};

const empty = (text: string, testId?: string) => (
  <p className="m-auto text-muted-foreground text-sm" data-testid={testId}>
    {text}
  </p>
);

export const ArtifactsPane = memo(function ArtifactsPane({ view, owner, label, load, connected, onOpenTab, requestOlder, failed, hidden }: Props) {
  const t = useT();
  const rows = useMemo(() => (view ? sessionArtifacts(view) : []), [view?.parts, view?.aux]);
  const want = !!view?.older && !view.auxArtifacts;
  useEffect(() => {
    if (want) requestOlder();
  }, [want, requestOlder]);
  const box = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(box);
  const current = useSyncExternalStore(subscribe, () => picked.get(owner));
  if (!view) return failed ? empty(t("files.artifacts.failed"), "artifacts-failed") : empty(t("files.artifacts.loading"));
  if (!rows.length) return empty(t("files.artifacts.empty"), "artifacts-empty");
  const wide = width === undefined || width >= WIDE;
  const at = Math.max(0, rows.findIndex((r) => r.partId === current?.partId));
  const sel = rows[at]!;
  const choose = (r: ArtifactRow) => selectArtifact(owner, r.partId, true);
  const key = (e: KeyboardEvent<HTMLElement>) => {
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + d))]!;
    selectArtifact(owner, next.partId);
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus());
  };
  const list = (
    <div role="listbox" aria-label={label} data-testid="artifacts-list" onKeyDown={key} className={cn("flex min-h-0 flex-col overflow-auto", wide ? "w-64 shrink-0 border-r" : "flex-1")}>
      {rows.map((r) => (
        <button key={r.partId} type="button" role="option" aria-selected={r.partId === sel.partId} tabIndex={r.partId === sel.partId ? 0 : -1} data-testid="artifact-row" onClick={() => choose(r)} className={cn("flex min-h-11 flex-col gap-0.5 border-b px-3 py-2 text-left text-sm md:min-h-0", r.partId === sel.partId && wide ? "bg-muted" : "hover:bg-muted/50")}>
          <span className="flex items-baseline gap-2">
            <span data-testid="artifact-row-title" className="min-w-0 flex-1 truncate font-medium">
              {r.title}
            </span>
            {r.at !== undefined && <span className="shrink-0 text-muted-foreground text-xs">{timeAgo(r.at)}</span>}
          </span>
          {r.fileName && r.fileName !== r.title && <span className="truncate text-muted-foreground text-xs">{r.fileName}</span>}
        </button>
      ))}
    </div>
  );
  const open = openButton(sel, onOpenTab, t);
  const preview = (
    <div data-testid="artifacts-preview" className="flex min-h-0 min-w-0 flex-1 flex-col gap-1 p-2">
      {!wide && (
        <Button type="button" variant="outline" size="sm" className="max-md:h-11 w-fit" onClick={() => selectArtifact(owner, sel.partId)}>
          <ChevronLeftIcon aria-hidden className="size-4" />
          {t("files.artifacts.all")}
        </Button>
      )}
      {sel.previewable ? hidden ? null : (
        <ArtifactConnectedContext value={connected}>
          <ArtifactPreviewContext value={load}>
            <ArtifactFrame key={sel.partId} partId={sel.partId} title={sel.title} fill actions={open} />
          </ArtifactPreviewContext>
        </ArtifactConnectedContext>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{t("files.artifacts.noPreview")}</p>
          {sel.url && isClaudeUrl(sel.url) && (
            <a href={sel.url} target="_blank" rel="noopener noreferrer" title={t("files.artifacts.opensInNewTab", { url: sel.url })} className="inline-flex min-h-11 items-center break-all underline md:min-h-0">
              {sel.url}
            </a>
          )}
        </div>
      )}
    </div>
  );
  return (
    <section ref={box} data-testid="artifacts-pane" aria-label={label} className="flex min-h-0 flex-1 outline-none">
      {wide ? (
        <>
          {list}
          {preview}
        </>
      ) : current?.detail ? (
        preview
      ) : (
        list
      )}
    </section>
  );
});

/** The "Open in tab" button of a previewable row. */
function openButton(row: ArtifactRow, onOpenTab: (partId: string) => void, t: ReturnType<typeof useT>) {
  return row.previewable ? (
    <Button type="button" variant="outline" size="sm" className="max-md:h-11" onClick={() => onOpenTab(row.partId)}>
      {t("files.openInTab")}
    </Button>
  ) : undefined;
}
