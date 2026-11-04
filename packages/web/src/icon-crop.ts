// Square crop of an uploaded icon (GH-515): pure geometry. The image is drawn at `scaleOf` with its top-left at (ox, oy) in a `view`-pixel square.
type Pan = { ox: number; oy: number };

/** Zoom 1 = the smaller side of the image exactly covers the square. */
export const scaleOf = (w: number, h: number, view: number, zoom: number) => (view / Math.min(w, h)) * zoom;

/** The image always covers the square. */
export function clampPan(w: number, h: number, view: number, zoom: number, ox: number, oy: number): Pan {
  const s = scaleOf(w, h, view, zoom);
  const c = (o: number, size: number) => Math.min(0, Math.max(view - size * s, o));
  return { ox: c(ox, w) + 0, oy: c(oy, h) + 0 };
}

/** Pan after a zoom change that keeps the image point at the centre of the square there. */
export function rezoom(w: number, h: number, view: number, from: number, ox: number, oy: number, to: number): Pan {
  const s0 = scaleOf(w, h, view, from);
  const s1 = scaleOf(w, h, view, to);
  const cx = (view / 2 - ox) / s0;
  const cy = (view / 2 - oy) / s0;
  return clampPan(w, h, view, to, view / 2 - cx * s1, view / 2 - cy * s1);
}

/** The visible part of the image, in image pixels (the source of drawImage). */
export function sourceRect(w: number, h: number, view: number, zoom: number, ox: number, oy: number) {
  const s = scaleOf(w, h, view, zoom);
  return { sx: -ox / s + 0, sy: -oy / s + 0, size: view / s };
}
