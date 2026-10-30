import type { ArtifactPreviewResult } from "@claude-ui/protocol";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { t, useT } from "./i18n.ts";

/** Asks the daemon for the preview URL of an Artifact publish part (artifact.preview). */
export type ArtifactPreviewLoader = (partId: string) => Promise<ArtifactPreviewResult>;
export const ArtifactPreviewContext = createContext<ArtifactPreviewLoader | undefined>(undefined);

/** Whether the daemon connection is up: a reconnect while a preview is open asks for a fresh URL (a restarted daemon forgot the old nonce). */
export const ArtifactConnectedContext = createContext(true);

/** Part ids whose card preview the user opened, one set per SessionView (GH-400: no module global): a remount of the card keeps it open (the URL is requested again), an artifact tab never touches it. */
export const ArtifactOpenedContext = createContext<Set<string> | undefined>(undefined);

/** Opens the artifact tab of a part of this session; absent: no "Open in tab" button. */
export const ArtifactTabContext = createContext<((partId: string) => void) | undefined>(undefined);

type State = "idle" | "loading" | { url: string; n: number; unavailable: string[]; title?: string } | { error: string; retry?: boolean };

const btn = "min-h-11 md:min-h-0";

/** "2 supporting files not loaded: a.css, b.js": the first three names, then an ellipsis. */
const notLoaded = (names: string[]) => t("files.artifact.notLoaded", { count: names.length, names: names.slice(0, 3).join(", ") + (names.length > 3 ? ", …" : "") });

/** The preview URL of one view of a part (GH-400): requested on mount, after a reconnect (down then up, when it has a URL or its request was cut) and on `reload`. Each view owns its URL. */
export function useArtifactUrl(partId: string): { state: State; reload: () => void } {
  const load = use(ArtifactPreviewContext);
  const connected = use(ArtifactConnectedContext);
  const [state, setState] = useState<State>("idle");
  const run = useRef(0);
  const frame = useRef(0); // key of the iframe: every answer remounts it, so Reload reloads even when the URL is the same
  const request = () => {
    if (!load) return;
    const mine = ++run.current;
    setState("loading");
    load(partId).then(
      (r) => mine === run.current && setState({ url: r.url, n: ++frame.current, unavailable: r.unavailable ?? [], title: r.title }),
      (e: { code?: string; message?: string }) => mine === run.current && setState({ error: t("files.artifact.unavailable", { reason: e?.code === "not_found" ? t("files.artifact.gone") : (e?.message ?? t("files.artifact.unknownError")) }), retry: e?.message === "disconnected" }),
    );
  };
  useEffect(() => {
    request();
    return () => void run.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId]);
  const was = useRef(connected);
  const live = useRef(state);
  live.current = state;
  useEffect(() => {
    if (connected && !was.current && typeof live.current === "object" && ("url" in live.current || live.current.retry)) request();
    was.current = connected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);
  return { state, reload: request };
}

/** The page of a part in a sandboxed iframe (no same-origin, scripts only, the daemon's CSP allows no network) under a toolbar: `actions`, then Reload. `fill`: the iframe takes the height of its flex parent (a tab). `onTitle`: the title of the daemon's reply. */
export function ArtifactFrame({ partId, title, fill, actions, onTitle }: { partId: string; title: string; fill?: boolean; actions?: ReactNode; onTitle?: (title: string) => void }): ReactNode {
  const t = useT();
  const load = use(ArtifactPreviewContext);
  const { state, reload } = useArtifactUrl(partId);
  const replied = typeof state === "object" && "url" in state ? state : undefined;
  useEffect(() => {
    if (replied?.title) onTitle?.(replied.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replied]);
  if (!load) return null;
  return (
    <div className={fill ? "flex min-h-0 flex-1 flex-col gap-1" : "space-y-1"}>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <Button variant="outline" size="sm" className={btn} onClick={reload}>
          {t("files.artifact.reload")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">{t("files.artifact.offlineNote")}</p>
      {replied && replied.unavailable.length > 0 && <p className="text-muted-foreground text-xs break-all">{notLoaded(replied.unavailable)}</p>}
      {state === "loading" && (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          {t("files.artifact.loading")}
        </p>
      )}
      {typeof state === "object" && "error" in state && (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      )}
      {replied && (
        <iframe
          key={replied.n}
          data-testid="artifact-preview"
          title={t("files.artifact.frameTitle", { title })}
          src={replied.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading={fill ? undefined : "lazy"}
          className={`block w-full rounded-md border bg-white ${fill ? "min-h-0 flex-1" : "h-[60vh] max-h-[480px]"}`}
        />
      )}
    </div>
  );
}

/** Collapsed "Show preview" of a local Artifact page (and "Open in tab" when a tab can open); open: an ArtifactFrame. */
export function ArtifactPreview({ partId, title }: { partId: string; title: string }): ReactNode {
  const t = useT();
  const load = use(ArtifactPreviewContext);
  const toTab = use(ArtifactTabContext);
  const own = useRef(new Set<string>()); // without a provider (a bare card): this card only
  const opened = use(ArtifactOpenedContext) ?? own.current;
  const [open, setOpen] = useState(() => opened.has(partId));
  if (!load) return null;
  const tab = toTab && (
    <Button variant="outline" size="sm" className={btn} onClick={() => toTab(partId)}>
      {t("files.openInTab")}
    </Button>
  );
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className={btn} aria-expanded={false} data-testid="artifact-preview-toggle" onClick={() => (opened.add(partId), setOpen(true))}>
          {t("files.artifact.show")}
        </Button>
        {tab}
      </div>
    );
  return (
    <ArtifactFrame
      partId={partId}
      title={title}
      actions={
        <>
          <Button variant="outline" size="sm" className={btn} aria-expanded={true} onClick={() => (opened.delete(partId), setOpen(false))}>
            {t("files.artifact.hide")}
          </Button>
          {tab}
        </>
      }
    />
  );
}
