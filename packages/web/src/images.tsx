// Prompt images: read pasted/dropped files as data URLs, show them as thumbnails.
import { imageBlock, isPromptImage, parseOmitted } from "@claude-ui/protocol";
import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { trapTab } from "./focus-trap.ts";
import { useT } from "./i18n.ts";
import { useMediaSrc } from "./media.ts";
import { MediaPlaceholder } from "./media-notice.tsx";

/** Data URLs of the files the API accepts as images (png, jpeg, gif, webp); other files are skipped. */
export async function readImages(files: Iterable<File>): Promise<string[]> {
  const urls = await Promise.all([...files].filter((f) => isPromptImage(f.type)).map(readDataUrl));
  return urls.filter((u) => imageBlock(u));
}

export const readDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** One image in its own aspect ratio (never cropped), a real button that opens it whole in a modal; Esc, the backdrop or Close returns the focus to it. */
function ImageThumb({ src: given, index, compact, partId }: { src: string; index: number; compact: boolean; partId?: string }) {
  const t = useT();
  const n = index + 1;
  // A large image a snapshot or page left out loads when shown (GH-274).
  const omitted = !!parseOmitted(given);
  const { src, failed, retry } = useMediaSrc(partId ?? "", index, omitted && !!partId, omitted ? undefined : given);
  if (!src) return <MediaPlaceholder failed={failed} retry={retry} label={t("files.image.n", { n })} className="h-24 w-40" />;
  return (
    <Dialog.Root>
      <Dialog.Trigger aria-label={t("files.image.view", { n })} className="block cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <img src={src} alt={t("files.image.n", { n })} className={cn("block h-auto w-auto rounded-md border object-contain", compact ? "max-h-16 max-w-32" : "max-h-40 max-w-64")} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Popup
          onKeyDown={trapTab}
          aria-label={t("files.image.n", { n })}
          aria-modal="true"
          data-testid="image-lightbox"
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 outline-none"
        >
          <img src={src} alt={t("files.image.n", { n })} className="block h-auto max-h-[90vh] w-auto max-w-[90vw] rounded-md object-contain" />
          <Dialog.Close
            aria-label={t("files.image.close")}
            className="absolute top-2 right-2 grid size-11 place-items-center rounded-full bg-black/60 text-white outline-none hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-5" />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** `partId`: the user_text part the images belong to, to load the ones a snapshot or page left out. */
export function ImageStrip({ images, onRemove, partId }: { images: string[]; onRemove?: (index: number) => void; partId?: string }) {
  const t = useT();
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-2" data-testid="image-strip">
      {images.map((src, i) => (
        <div key={i} className="relative max-w-full">
          <ImageThumb src={src} index={i} compact={!!onRemove} partId={partId} />
          {onRemove && (
            <button
              type="button"
              aria-label={t("files.image.remove", { n: i + 1 })}
              className="absolute -top-1.5 -right-1.5 rounded-full border bg-background p-0.5 hover:bg-muted"
              onClick={() => onRemove(i)}
            >
              <XIcon className="size-3" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
