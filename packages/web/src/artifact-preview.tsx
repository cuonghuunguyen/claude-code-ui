import type { ArtifactPreviewResult } from "@claude-ui/protocol";
import { createContext, use, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Asks the daemon for the preview URL of an Artifact publish part (artifact.preview). */
export type ArtifactPreviewLoader = (partId: string) => Promise<ArtifactPreviewResult>;
export const ArtifactPreviewContext = createContext<ArtifactPreviewLoader | undefined>(undefined);

// ponytail: part ids whose preview the user opened, kept outside React like `expanded` in tool-card.tsx so a remount keeps it open (the URL is requested again).
const opened = new Set<string>();

type State = "idle" | "loading" | { url: string } | { error: string };

const btn = "min-h-11 md:min-h-0";

/** Collapsed "Show preview" of a local Artifact page; open: the page in a sandboxed iframe (no same-origin, scripts only, the daemon's CSP allows no network). */
export function ArtifactPreview({ partId, title, files }: { partId: string; title: string; files: number }): ReactNode {
  const load = use(ArtifactPreviewContext);
  const [state, setState] = useState<State>("idle");
  const run = useRef(0);
  const request = (loader: ArtifactPreviewLoader) => {
    const mine = ++run.current;
    opened.add(partId);
    setState("loading");
    loader(partId).then(
      (r) => mine === run.current && setState({ url: r.url }),
      (e: { code?: string; message?: string }) => mine === run.current && setState({ error: `Preview not available: ${e?.code === "not_found" ? "file is gone" : (e?.message ?? "unknown error")}` }),
    );
  };
  useEffect(() => {
    if (load && opened.has(partId)) request(load);
    return () => void run.current++;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId]);
  if (!load) return null;
  const hide = () => {
    run.current++;
    opened.delete(partId);
    setState("idle");
  };
  if (state === "idle")
    return (
      <Button variant="outline" size="sm" className={btn} aria-expanded={false} data-testid="artifact-preview-toggle" onClick={() => request(load)}>
        Show preview
      </Button>
    );
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className={btn} aria-expanded={true} onClick={hide}>
          Hide preview
        </Button>
        <Button variant="outline" size="sm" className={btn} onClick={() => request(load)}>
          Reload
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">Local file, shown offline: remote scripts, images and fonts do not load.</p>
      {files > 0 && <p className="text-muted-foreground text-xs">{`Main page only: ${files} supporting ${files === 1 ? "file" : "files"} not loaded.`}</p>}
      {state === "loading" && (
        <p aria-live="polite" className="text-muted-foreground text-xs">
          Loading preview…
        </p>
      )}
      {typeof state === "object" && "error" in state && (
        <p role="alert" className="text-destructive text-xs">
          {state.error}
        </p>
      )}
      {typeof state === "object" && "url" in state && (
        <iframe
          data-testid="artifact-preview"
          title={`Preview: ${title}`}
          src={state.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="block h-[60vh] max-h-[480px] w-full rounded-md border bg-white"
        />
      )}
    </div>
  );
}
