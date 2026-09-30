// Editor tab state (docs/spec.md "Editor"): the disk version the tab is based on, the user's draft, and a pending conflict.
import type { FsReadResult } from "@claude-ui/protocol";

export type Tab = {
  path: string;
  /** Content of the disk version identified by `mtime`. */
  disk: string;
  mtime: number;
  draft: string;
  /** A newer disk version that arrived while the draft had unsaved edits. */
  conflict?: FsReadResult;
  error?: string;
};

export const opened = (path: string, r: FsReadResult): Tab => ({ path, disk: r.content, mtime: r.mtime, draft: r.content });

export const isDirty = (t: Tab) => t.draft !== t.disk;

/** A disk version read after a change: a clean tab reloads, a dirty one gets a conflict. */
export function diskChanged(t: Tab, r: FsReadResult): Tab {
  if (r.mtime === t.mtime) return t;
  if (r.content === t.disk) return { ...t, mtime: r.mtime, conflict: undefined };
  if (!isDirty(t)) return { ...t, disk: r.content, draft: r.content, mtime: r.mtime, conflict: undefined, error: undefined };
  return { ...t, conflict: r };
}

/** Takes the conflicting disk version, dropping the draft. */
export const reload = (t: Tab): Tab =>
  t.conflict
    ? { ...t, disk: t.conflict.content, draft: t.conflict.content, mtime: t.conflict.mtime, conflict: undefined, error: undefined }
    : t;

/** `content` was written with the resulting `mtime`; the draft may have moved on meanwhile. */
export const saved = (t: Tab, content: string, mtime: number): Tab => ({
  ...t,
  disk: content,
  mtime,
  conflict: undefined,
  error: undefined,
});

export const inDir = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
