// Viewer tab for image, SVG, video and audio files (docs/spec.md "Editor"): the bytes come from the daemon's /media URL.
import { useState } from "react";
import type { FsMediaResult } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { fileSize, mediaKind } from "./files.ts";
import { baseName } from "./paths.ts";

const touch = "max-md:h-11 pointer-coarse:h-11";

/** Keyed by the media URL by the parent: a new URL (file changed) resets the failure and the size. */
export function MediaView({ path, media, onShowSource }: { path: string; media: FsMediaResult; onShowSource?: () => void }) {
  const kind = mediaKind(path)!;
  const [failed, setFailed] = useState(false);
  const [fit, setFit] = useState(true);
  const [dims, setDims] = useState<[number, number]>();
  const isImage = kind === "image" || kind === "svg";
  const onError = () => setFailed(true);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="media-view">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={path}>
          {baseName(path)}
        </span>
        <span className="shrink-0 text-muted-foreground" data-testid="media-info">
          {isImage && dims ? `${dims[0]}×${dims[1]} · ` : ""}
          {fileSize(media.size)}
        </span>
        {isImage && !failed && (
          <Button size="xs" variant="outline" aria-pressed={!fit} onClick={() => setFit((f) => !f)} className={touch} data-testid="media-fit">
            100%
          </Button>
        )}
        {onShowSource && (
          <Button size="xs" variant="outline" onClick={onShowSource} className={touch}>
            Show source
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-muted/40 p-4">
        {failed ? (
          <p role="status" className="text-muted-foreground text-sm" data-testid="file-notice">
            Unable to load {kind === "svg" ? "image" : kind}.
          </p>
        ) : isImage ? (
          <img
            src={media.url}
            alt={baseName(path)}
            data-testid="media-image"
            onLoad={(e) => setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
            onError={onError}
            className={fit ? "max-h-full max-w-full object-contain" : "max-w-none"}
          />
        ) : kind === "video" ? (
          <video src={media.url} controls preload="metadata" playsInline data-testid="media-video" onError={onError} className="max-h-full max-w-full" />
        ) : (
          <audio src={media.url} controls preload="metadata" data-testid="media-audio" onError={onError} className="w-full max-w-xl" />
        )}
      </div>
    </div>
  );
}
