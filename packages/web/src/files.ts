// Editor tab state (docs/spec.md "Editor"): the disk version the tab is based on, the user's draft, and a pending conflict.
import { Compartment, EditorState, Text, type TransactionSpec } from "@codemirror/state";
import type { FsMediaResult, FsReadResult } from "@claude-ui/protocol";
import type { RequestError } from "./client.ts";
import { t } from "./i18n.ts";
import { mentionPath } from "./mentions.ts";
import { isWinPath, relPath } from "./paths.ts";

export type Tab = {
  path: string;
  /** Content of the disk version identified by `mtime`. */
  disk: string;
  mtime: number;
  draft: string;
  /** A newer disk version that arrived while the draft had unsaved edits. */
  conflict?: FsReadResult;
  error?: string;
  /** The file turned into one that cannot be shown (binary, too large, not UTF-8) while the tab had no edits: shown in place of the editor. */
  notice?: string;
  /** What the editor can open instead, under `notice`. */
  noticeHint?: string;
  /** A preview tab (italic): the next single-click open replaces it; an edit, a save or a double click pins it. */
  preview?: boolean;
  /** A media tab (image, SVG, video, audio viewer): `disk` and `draft` are empty, so it is never dirty. */
  media?: FsMediaResult;
  /** Opened from the timeline from outside the session folder: the file dialog lists it, the Files tab does not. */
  outside?: boolean;
  /** GH-399: the file shows in its own main-area tab, not in Files; never a preview. */
  item?: boolean;
  /** A restored draft whose file is gone: Save creates it again (GH-366). */
  gone?: true;
};

export const openedMedia = (path: string, m: FsMediaResult): Tab => ({ path, disk: "", draft: "", mtime: m.mtime, media: m });

const MEDIA_KINDS: Record<string, "image" | "svg" | "video" | "audio"> = {
  ...Object.fromEntries([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"].map((e) => [e, "image"])),
  ".svg": "svg",
  ...Object.fromEntries([".mp4", ".webm", ".mov", ".ogv"].map((e) => [e, "video"])),
  ...Object.fromEntries([".ogg", ".mp3", ".wav", ".m4a", ".flac"].map((e) => [e, "audio"])),
};

/** Viewer kind of a file by extension; mirrors the daemon's MEDIA_TYPES (like MAX_FILE_BYTES below). */
export function mediaKind(path: string): "image" | "svg" | "video" | "audio" | undefined {
  const ext = /\.[^./\\]*$/.exec(path)?.[0].toLowerCase();
  return ext && Object.hasOwn(MEDIA_KINDS, ext) ? MEDIA_KINDS[ext] : undefined;
}

export const opened = (path: string, r: FsReadResult): Tab => ({ path, disk: r.content, mtime: r.mtime, draft: r.content });

/** Markdown files get the Source / Preview / Split control. */
export const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

export type MdView = "source" | "preview" | "split";
const MD_VIEW_KEY = "claude-ui.markdown-view";
/** The markdown view, one choice per browser; Source by default (VS Code). */
export function loadMdView(): MdView {
  try {
    const v = localStorage.getItem(MD_VIEW_KEY);
    return v === "preview" || v === "split" ? v : "source";
  } catch {
    return "source";
  }
}
export function saveMdView(v: MdView) {
  try {
    localStorage.setItem(MD_VIEW_KEY, v);
  } catch {
    // Storage unavailable: the choice lasts until the page reloads.
  }
}

export const isDirty = (t: Tab) => t.draft !== t.disk;

/** The tab as a regular one. */
export const pin = (t: Tab): Tab => {
  if (!t.preview) return t;
  const { preview: _, ...rest } = t;
  return rest;
};

/**
 * Opens `tab` among `tabs` (VS Code's preview editor). A new tab opened as `preview` replaces the one preview tab inside `scope`, at its position;
 * an open tab stays, and a pinned open (`preview` false) pins it.
 */
export function placeTab(tabs: Record<string, Tab>, tab: Tab, preview: boolean, scope: (path: string) => boolean): Record<string, Tab> {
  const open = tabs[tab.path];
  if (open) return preview ? tabs : { ...tabs, [tab.path]: pin(open) };
  if (!preview) return { ...tabs, [tab.path]: pin(tab) };
  const old = Object.keys(tabs).find((p) => scope(p) && tabs[p]!.preview);
  const next: Tab = { ...tab, preview: true };
  if (old === undefined) return { ...tabs, [tab.path]: next };
  return Object.fromEntries(Object.entries(tabs).map(([p, t]) => (p === old ? [tab.path, next] : [p, t])));
}

/**
 * A tab restored after a reload (GH-366) from the current disk version `r` and the saved draft `d` (`mtime`: the disk version it was based on).
 * A draft on a changed file keeps the conflict: `mtime = r.mtime`, so the next `diskChanged(t, r)` keeps it and a plain Save stays refused.
 */
export function restoredTab(path: string, r: FsReadResult, d?: { draft: string; mtime: number; conflict?: boolean }): Tab {
  const t = opened(path, r);
  if (!d || d.draft === r.content) return t;
  return r.mtime === d.mtime && !d.conflict ? { ...t, draft: d.draft } : { ...t, draft: d.draft, conflict: r };
}

/** A saved draft whose file is gone (or cannot be read: `error`): kept dirty; Save creates the file again. */
export const goneTab = (path: string, d: { draft: string }, error = t("files.goneError")): Tab => ({ path, disk: "", mtime: 0, draft: d.draft, gone: true, error });

/** A disk version read after a change: a clean tab reloads, a dirty one gets a conflict. */
export function diskChanged(t: Tab, r: FsReadResult): Tab {
  // The file came back: the draft meets it as a conflict, never overwrites it.
  if (t.gone) return diskChanged({ ...t, gone: undefined, error: undefined }, r);
  if (t.notice) return { ...t, disk: r.content, draft: r.content, mtime: r.mtime, conflict: undefined, error: undefined, notice: undefined, noticeHint: undefined };
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

/** `baseMtime` of a save: "Overwrite with mine" replaces the disk version seen in the conflict banner; a plain save of a tab in conflict gets refused. */
export const saveBase = (t: Tab, overwrite: boolean) => (overwrite && t.conflict ? t.conflict.mtime : t.mtime);

/** `content` was written with the resulting `mtime`; the draft may have moved on meanwhile. */
export const saved = (t: Tab, content: string, mtime: number): Tab => ({
  ...t,
  disk: content,
  mtime,
  conflict: undefined,
  error: undefined,
});


// CodeMirror splits on any line break and joins with "\n" unless the separator is set: a CRLF file would turn dirty and save as LF.
const separator = new Compartment();
const lineBreak = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

/** Editor extension that keeps `text`'s line breaks; the other kind of break stays inside a line, so the text round-trips as is. */
export const lineBreaks = (text: string) => separator.of(EditorState.lineSeparator.of(lineBreak(text)));

/** Replaces the whole document with `text`, switching to its line breaks. */
export function replaceDoc(state: EditorState, text: string): TransactionSpec {
  const sep = lineBreak(text);
  return {
    changes: { from: 0, to: state.doc.length, insert: Text.of(text.split(sep)) },
    effects: separator.reconfigure(EditorState.lineSeparator.of(sep)),
  };
}

/** The document joined with its own line breaks (`doc.toString()` always joins with "\n"). */
export const docText = (state: EditorState) => state.sliceDoc();

/** A Windows path in "/": the CLI resolves either, and "\" would read as an escape in a quoted mention. */
const mentionRel = (path: string, cwd: string) => (isWinPath(path) ? relPath(path, cwd).replace(/\\/g, "/") : relPath(path, cwd));

/** "Add to prompt" from the file tree: `@path` of the file, relative to `cwd`. */
export const fileMention = (path: string, cwd: string) => mentionPath(mentionRel(path, cwd));

/**
 * "Send selection to Claude": `@path#Lstart-end` of the main selection, path relative to `cwd`; the file alone when nothing is selected.
 * The SDK attaches only the range for `#L…` (`#start-end` attaches the whole file), and a quoted path needs the range inside the quotes.
 */
export function selectionMention(state: EditorState, path: string, cwd: string) {
  const rel = mentionRel(path, cwd);
  const { from, to, empty } = state.selection.main;
  if (empty) return mentionPath(rel);
  const start = state.doc.lineAt(from);
  const end = state.doc.lineAt(to);
  // A selection that ends at the start of a line (whole lines selected) does not include that line.
  const last = end.number > start.number && to === end.from ? end.number - 1 : end.number;
  return mentionPath(`${rel}#L${start.number}${last > start.number ? `-${last}` : ""}`);
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${+(n / 1024).toFixed(1)} KB` : `${+(n / 1024 ** 2).toFixed(1)} MB`);

/** Mirrors the daemon's MAX_FILE_BYTES (fs.read). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The fs.read checks on a file the daemon already decoded (the changes tab's before side, from the SDK): too large, UTF-16 BOM or NUL bytes,
 * or U+FFFD from invalid UTF-8. Undefined for text. ponytail: a text file that holds U+FFFD itself counts as not UTF-8.
 */
export function textFailure(s: string): { text: string; notice: boolean; hint?: string } | undefined {
  const byteSize = new TextEncoder().encode(s).length;
  const code = byteSize > MAX_FILE_BYTES ? "too_large" : /^\ufffd\ufffd(\0[^\0]|[^\0\ufffd]\0)/.test(s) ? "not_utf8" : s.includes("\0") ? "binary" : s.includes("\ufffd") ? "not_utf8" : undefined;
  // The decoded string has no true byte size, so only a too large file shows one.
  return code && readFailure(Object.assign(new Error(code), { code, size: code === "too_large" ? byteSize : undefined }));
}

/** What the viewer says about a failed fs.read: `notice` for a file that cannot be shown (not an error), no raw error code. */
export function readFailure(e: RequestError): { text: string; notice: boolean; hint?: string } {
  const size = e.size === undefined ? "" : ` (${fileSize(e.size)})`;
  switch (e.code) {
    case "binary":
      return { text: t("files.read.binary", { size }), notice: true, hint: t("files.read.binaryHint") };
    case "too_large":
      return { text: t("files.read.tooLarge", { size }), notice: true, hint: t("files.read.tooLargeHint") };
    case "not_utf8":
      return { text: t("files.read.notUtf8", { size }), notice: true, hint: t("files.read.notUtf8Hint") };
    case "not_a_file":
      return { text: t("files.read.notAFile"), notice: true };
    default:
      return { text: e.message, notice: false };
  }
}

const below = (p: string, dir: string) => {
  if (isWinPath(dir)) {
    const [k, d] = [p.replace(/\//g, "\\").toLowerCase(), dir.replace(/\//g, "\\").toLowerCase()];
    return k === d || k.startsWith(d + "\\");
  }
  return p === dir || p.startsWith(dir + "/");
};

/** The tabs after `from` was renamed to `to` (a file, or a folder: every tab below it): keys and paths change, drafts and order stay. */
export function moveTabs(tabs: Record<string, Tab>, from: string, to: string): Record<string, Tab> {
  const out: Record<string, Tab> = {};
  for (const [k, t] of Object.entries(tabs)) {
    const p = below(k, from) ? to + k.slice(from.length) : k;
    out[p] = p === k ? t : { ...t, path: p };
  }
  return out;
}

/** The tab key `path` has after `from` became `to`. */
export const movedPath = (path: string, from: string, to: string) => (below(path, from) ? to + path.slice(from.length) : path);

/** The tabs after `path` was deleted: the clean tabs below it close, tabs with unsaved edits stay. */
export function dropTabs(tabs: Record<string, Tab>, path: string): Record<string, Tab> {
  return Object.fromEntries(Object.entries(tabs).filter(([k, t]) => !below(k, path) || isDirty(t)));
}
