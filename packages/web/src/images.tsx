// Prompt images: read pasted/dropped files as data URLs, show them as thumbnails.
import { imageBlock } from "@claude-ui/protocol";
import { XIcon } from "lucide-react";

/** Data URLs of the files the API accepts as images (png, jpeg, gif, webp); other files are skipped. */
export async function readImages(files: Iterable<File>): Promise<string[]> {
  const urls = await Promise.all([...files].filter((f) => f.type.startsWith("image/")).map(readDataUrl));
  return urls.filter((u) => imageBlock(u));
}

export const readDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

export function ImageStrip({ images, onRemove }: { images: string[]; onRemove?: (index: number) => void }) {
  if (!images.length) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="image-strip">
      {images.map((src, i) => (
        <div key={i} className="relative">
          <a href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={`Image ${i + 1}`} className="size-16 rounded-md border object-cover" />
          </a>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove image ${i + 1}`}
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
