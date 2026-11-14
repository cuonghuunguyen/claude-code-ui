import type * as Pierre from "@pierre/diffs";
import { lazy, useEffect, useState } from "react";

/**
 * @pierre/diffs (its renderer, parser and Shiki grammars, ~530 KB) is a separate chunk: the app loads it with the first diff
 * that is drawn (tool card, Changes tab, viewer compare), not with the entry. The themes of code-palette.ts register as the
 * library loads, so they are in place before any diff renders.
 */
let loaded: typeof Pierre | undefined;
let pending: Promise<typeof Pierre> | undefined;
const listeners = new Set<() => void>();

export function loadPierre(): Promise<typeof Pierre> {
  return (pending ??= Promise.all([import("@pierre/diffs"), import("./code-palette.ts")]).then(
    ([pierre, palette]) => {
      palette.registerDiffThemes(pierre.registerCustomTheme);
      loaded = pierre;
      for (const l of listeners) l();
      return pierre;
    },
    (e) => {
      pending = undefined;
      throw e;
    },
  ));
}

/** The library once it has loaded (undefined before): starts the load on first use and re-renders when done. */
export function usePierre(): typeof Pierre | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    if (loaded) return;
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    void loadPierre().catch(() => undefined);
    return () => void listeners.delete(l);
  }, []);
  return loaded;
}

/** The diff components, loaded on first render: draw them inside a `Suspense` whose fallback has the diff's final size. */
// `lazy` drops the components' generics (annotation type), so they are typed as the library's own.
type React_ = typeof import("@pierre/diffs/react");
export const MultiFileDiff = lazy(() => loadPierre().then(() => import("@pierre/diffs/react")).then((m) => ({ default: m.MultiFileDiff }))) as unknown as React_["MultiFileDiff"];
export const PierreFileDiff = lazy(() => loadPierre().then(() => import("@pierre/diffs/react")).then((m) => ({ default: m.FileDiff }))) as unknown as React_["FileDiff"];

/** Row height of the diff view (13px mono on 20px lines, 8px above and below; DIFF_OPTIONS) and its file header. */
const ROW = 20;
const PAD = 16;
const HEADER = 36;

/** Fallback of a diff while its chunk loads: a box of about the diff's size, so the rows below do not jump when it draws. */
export function DiffSkeleton({ rows, header = true, className }: { rows: number; header?: boolean; className?: string }) {
  return <div aria-hidden="true" className={className} data-testid="diff-skeleton" style={{ height: rows * ROW + PAD + (header ? HEADER : 0) }} />;
}
