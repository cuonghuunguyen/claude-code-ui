import type { ArtifactPreviewResult } from "@claude-ui/protocol";
import { Menu } from "@base-ui/react/menu";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useKeyboardOpen } from "./dock-area.tsx";
import { t, useT } from "./i18n.ts";
import { ITEM, POPUP } from "./session-actions.tsx";

/** Asks the daemon for the preview URL of an Artifact publish part (artifact.preview). */
export type ArtifactPreviewLoader = (partId: string) => Promise<ArtifactPreviewResult>;
export const ArtifactPreviewContext = createContext<ArtifactPreviewLoader | undefined>(undefined);

/** Whether the daemon connection is up: a reconnect while a preview is open asks for a fresh URL (a restarted daemon forgot the old nonce). */
export const ArtifactConnectedContext = createContext(true);

/** Part ids whose card preview the user opened, one set per SessionView (GH-400: no module global): a remount of the card keeps it open (the URL is requested again), an artifact tab never touches it. */
export const ArtifactOpenedContext = createContext<Set<string> | undefined>(undefined);

/** Opens the artifact tab of a part of this session; absent: no "Open in tab" button. */
export const ArtifactTabContext = createContext<((partId: string) => void) | undefined>(undefined);

/** GH-512: claude.ai URL -> part id of a previewable publish of this session; a link in assistant text with such a URL gets the menu. */
export const ArtifactUrlContext = createContext<ReadonlyMap<string, string> | undefined>(undefined);

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

/** The card's open state, shared with `opened` (see ArtifactOpenedContext). */
export function usePreviewOpen(partId: string): [boolean, (o: boolean) => void] {
  const own = useRef(new Set<string>()); // without a provider (a bare card): this card only
  const opened = use(ArtifactOpenedContext) ?? own.current;
  const [open, set] = useState(() => opened.has(partId));
  return [open, (o) => (o ? opened.add(partId) : opened.delete(partId), set(o))];
}

/** Collapsed "Show preview" of a local Artifact page (and "Open in tab" when a tab can open); open: an ArtifactFrame. `open`/`onOpenChange`: controlled by the card (the link menu's Preview). */
export function ArtifactPreview({ partId, title, open: controlled, onOpenChange }: { partId: string; title: string; open?: boolean; onOpenChange?: (o: boolean) => void }): ReactNode {
  const t = useT();
  const load = use(ArtifactPreviewContext);
  const toTab = use(ArtifactTabContext);
  const [own, setOwn] = usePreviewOpen(partId);
  const open = controlled ?? own;
  const setOpen = onOpenChange ?? setOwn;
  if (!load) return null;
  const tab = toTab && (
    <Button variant="outline" size="sm" className={btn} onClick={() => toTab(partId)}>
      {t("files.openInTab")}
    </Button>
  );
  if (!open)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className={btn} aria-expanded={false} data-testid="artifact-preview-toggle" onClick={() => setOpen(true)}>
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
          <Button variant="outline" size="sm" className={btn} aria-expanded={true} onClick={() => setOpen(false)}>
            {t("files.artifact.hide")}
          </Button>
          {tab}
        </>
      }
    />
  );
}

/**
 * GH-512: a claude.ai artifact link. A plain click opens a menu (Preview when `onPreview`, Open in tab, Open on claude.ai); Ctrl/Cmd/Shift/Alt
 * and middle click keep the native new tab. Without ArtifactTabContext or `partId` it is a plain link.
 */
export function ArtifactLinkMenu({ url, partId, onPreview, className }: { url: string; partId?: string; onPreview?: () => void; className?: string }) {
  const t = useT();
  const toTab = use(ArtifactTabContext);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const kb = useKeyboardOpen();
  const menu = !!toTab && !!partId;
  const item = cn(ITEM, "pointer-coarse:min-h-11");
  return (
    <>
      <a
        ref={anchor}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={t("session.toolCard.opensNewTab", { url })}
        className={className}
        aria-haspopup={menu ? "menu" : undefined}
        aria-expanded={menu ? open : undefined}
        onClick={(e) => {
          if (!menu || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          // Enter on a focused link is a click with detail 0: the menu then takes the focus.
          kb.root.onOpenChange(true, { event: e.nativeEvent });
          setOpen(true);
        }}
      >
        {url}
      </a>
      {menu && (
        <Menu.Root open={open} onOpenChange={(o) => setOpen(o)} onOpenChangeComplete={kb.root.onOpenChangeComplete}>
          <Menu.Portal>
            <Menu.Positioner anchor={anchor} sideOffset={4} className="z-50">
              <Menu.Popup ref={kb.popup} className={POPUP}>
                {onPreview && (
                  <Menu.Item className={item} onClick={onPreview} data-testid="artifact-link-preview">
                    {t("files.artifact.preview")}
                  </Menu.Item>
                )}
                <Menu.Item className={item} onClick={() => toTab(partId)} data-testid="artifact-link-tab">
                  {t("files.openInTab")}
                </Menu.Item>
                <Menu.LinkItem className={item} href={url} target="_blank" rel="noopener noreferrer" data-testid="artifact-link-claude">
                  {t("files.artifact.openOnClaude")}
                </Menu.LinkItem>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </>
  );
}
