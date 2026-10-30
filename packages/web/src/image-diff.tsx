// Changes tab, git modes: a changed image as images (docs/spec.md "Layout"): before (file at the base commit) and after (disk), both through fs.media.
import { useState } from "react";
import type { FsMediaResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import { fileSize } from "./files.ts";
import { useT } from "./i18n.ts";
import { baseName } from "./paths.ts";

/** One side: its media, or the notice why it cannot be shown. */
export type ImagePane = { media?: FsMediaResult; error?: string; notice?: boolean };

export function ImageDiff({ path, before, after, split }: { path: string; before?: ImagePane; after?: ImagePane; split: boolean }) {
  const t = useT();
  const panes = [before && (["before", t("files.imageDiff.before"), before] as const), after && (["after", t("files.imageDiff.after"), after] as const)].filter(Boolean) as (readonly ["before" | "after", string, ImagePane])[];
  return (
    <div className={cn("grid gap-2 p-2", split && panes.length === 2 ? "grid-cols-2" : "grid-cols-1")} data-testid="image-diff">
      {panes.map(([id, label, p]) => (
        <Pane key={id} id={id} label={label} path={path} pane={p} />
      ))}
    </div>
  );
}

function Pane({ id, label, path, pane }: { id: string; label: string; path: string; pane: ImagePane }) {
  const t = useT();
  const [failed, setFailed] = useState<string>();
  const [dims, setDims] = useState<[number, number]>();
  const url = pane.media?.url;
  return (
    <figure className="flex min-w-0 flex-col gap-1" data-testid={`image-${id}`}>
      <figcaption className="flex gap-2 text-muted-foreground text-xs">
        <span className="font-medium">{label}</span>
        {pane.media && (
          <span data-testid="image-info">
            {dims ? `${dims[0]}×${dims[1]} · ` : ""}
            {fileSize(pane.media.size)}
          </span>
        )}
      </figcaption>
      <div className="flex min-h-40 items-center justify-center rounded bg-muted/40 px-6 py-4">
        {pane.error ? (
          <p role={pane.notice ? "status" : "alert"} className={pane.notice ? "text-muted-foreground" : "text-destructive"}>
            {pane.error}
          </p>
        ) : failed === url ? (
          <p role="status" className="text-muted-foreground">
            {t("files.imageDiff.unable")}
          </p>
        ) : (
          url && (
            <img
              key={url}
              src={url}
              alt={t("files.imageDiff.alt", { name: baseName(path), label: label.toLowerCase() })}
              onLoad={(e) => setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
              onError={() => setFailed(url)}
              className="max-h-[60vh] max-w-full rounded border bg-background object-contain"
            />
          )
        )}
      </div>
    </figure>
  );
}
