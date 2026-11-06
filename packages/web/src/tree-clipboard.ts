// The file tree's clipboard (GH-555): one entry, shared by every tree of the tab, and a "folder changed" signal so another tree lists it again.
export type ClipEntry = { op: "copy" | "cut"; path: string; name: string; isDir: boolean; /** Daemon (side) id the entry lives on. */ side: string };

let entry: ClipEntry | undefined;
const subs = new Set<() => void>();
const changed = new Set<(side: string, dir: string) => void>();

export const treeClipboard = {
  get: () => entry,
  set(e: ClipEntry) {
    entry = e;
    subs.forEach((f) => f());
  },
  clear() {
    entry = undefined;
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
  /** A paste changed `dir` on `side`. */
  notifyChanged: (side: string, dir: string) => changed.forEach((f) => f(side, dir)),
  onChanged(f: (side: string, dir: string) => void) {
    changed.add(f);
    return () => void changed.delete(f);
  },
};
