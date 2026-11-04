import { cn } from "@/lib/utils";
import { iconSrc } from "./labels.ts";

/** A label's icon (GH-515): an image from a raster data URL, else the emoji text. `className` sizes both. */
export function LabelIcon({ icon, className }: { icon: string; className?: string }) {
  const src = iconSrc(icon);
  if (src) return <img alt="" src={src} className={cn("shrink-0 rounded-sm object-cover", className)} data-testid="label-glyph-img" />;
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center overflow-hidden leading-none", className)} data-testid="label-glyph-emoji">
      {icon}
    </span>
  );
}
