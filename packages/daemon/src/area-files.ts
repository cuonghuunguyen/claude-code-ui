// Area: the file tree, the editor and file history (`fs.*` except `fs.upload`, `history.*`, `media.read`).
// Per-connection state: the watched paths, the running grep and replace dry run, the replace write flag and the cache of files at a commit;
// `close` stops them.
import { closeSync, existsSync, fstatSync, ftruncateSync, statSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { CHUNK_BYTES, MAX_SEARCH_CHARS, parseEditorCommand, type FsEntry, type FsGrepResult, type MediaReadResult } from "@claude-ui/protocol";
import type { FilesTypes } from "./areas.ts";
import type { DaemonContext, MediaRead } from "./daemon-context.ts";
import type { Area, Connection, Handlers, Msg, Respond } from "./dispatch.ts";
import { openChecked, OPEN_READ, OPEN_WRITE, readAll, readdirChecked, real, sameFile, writeAll } from "./fd-check.ts";
import { copyEntry, createEntry, deleteEntry, duplicateFile, readFileChunk, renameEntry, walkEntry, writeFileChunk } from "./fs-ops.ts";
import { gitBlobRead, gitBlobRef } from "./git.ts";
import { GitRequestError, gitRequest, read as gitRead } from "./git-request.ts";
import { findInFiles, GREP_LIMITS, GrepError, matcher, parseGlobs } from "./grep.ts";
import { HistoryError } from "./local-history.ts";
import { MEDIA_BLOB_CACHE_MAX, MEDIA_BLOB_MAX, MEDIA_CHUNK, mediaType } from "./media.ts";
import { customCommand, EDITORS, findOnPath, isOpenWith, openCommand } from "./open-external.ts";
import { replaceInFiles, ReplaceError, undoReplace } from "./replace.ts";
import { clearSearchCache, searchFiles } from "./search.ts";
import { MAX_FILE_BYTES, decodeText } from "./text-file.ts";
import { visualizeReadable } from "./visualize-write.ts";

// ponytail: stat polling, robust to atomic rename-writes and WSL; fs.watch per directory if many tabs make polling costly.
export const WATCH_INTERVAL_MS = 1000;

export type FilesAreaContext = Pick<DaemonContext, "git" | "allowed" | "inside" | "roots" | "missingInRoots" | "localHistory" | "replaceUndo" | "reposOf" | "lastOpen" | "appSettings" | "media" | "fsOps" | "uploads"> & { opts: Pick<DaemonContext["opts"], "openExternal"> };

export function createFilesArea(ctx: FilesAreaContext, conn: Connection): Area<FilesTypes> {
  const { git, allowed, inside, roots, missingInRoots, localHistory, replaceUndo, reposOf, lastOpen, appSettings, media, fsOps, uploads, opts } = ctx;
  // fs.watch: watched path as the client gave it → canonical path and its stat listener.
  const watched = new Map<string, { real: string; listener: (curr: Stats, prev: Stats) => void }>();
  /** The running `fs.grep` of this connection: stopped by a newer one and the close. */
  let grepping: AbortController | undefined;
  /** The running `fs.replace` dry run of this connection (a newer one and the close stop it), and whether an apply or undo is running. */
  let replacing: AbortController | undefined;
  let writingReplace = false;
  const unwatchAll = () => {
    watched.forEach((w) => unwatchFile(w.real, w.listener));
    watched.clear();
  };
  /** Files at a commit that media.read read (a commit's file never changes): least recently used first, at most MEDIA_BLOB_CACHE_MAX bytes per connection. */
  const blobs = new Map<string, Buffer>();
  const blobCached = (key: string) => {
    const b = blobs.get(key);
    if (b) (blobs.delete(key), blobs.set(key, b));
    return b;
  };
  const blobKeep = (key: string, buf: Buffer) => {
    blobs.set(key, buf);
    let total = 0;
    blobs.forEach((b) => (total += b.length));
    for (const [k, b] of blobs) {
      if (total <= MEDIA_BLOB_CACHE_MAX || k === key) break;
      blobs.delete(k);
      total -= b.length;
    }
  };
  type MediaFail = { code: string; message: string; size?: number };
  /** media.read and fs.media {hash}: a piece of a media file or of a file at a commit, with the roots and extension checks. */
  const readMedia = async (m: { path: unknown; cwd?: unknown; hash?: unknown; exact?: unknown; offset: number; length: number }): Promise<MediaReadResult | MediaFail> => {
    if (typeof m.path !== "string") return { code: "bad_request", message: "path must be a string" };
    const path = m.path;
    const mime = mediaType(path);
    if (m.hash !== undefined) {
      const o = await gitRequest(git, m, gitRead(async (cwd, inside) => {
        if (!mime) throw new GitRequestError("unsupported_type", `not an image, video or audio file: ${path}`);
        const key = `${cwd}\0${String(m.hash)}\0${path}`;
        let buf = blobCached(key);
        // Size only (the first read of every GET): git cat-file -s, no blob read.
        if (!buf && m.length === 0) return { data: "", size: (await gitBlobRef(cwd, m.hash as string, path, inside, MEDIA_BLOB_MAX)).size, mtime: 0, mime };
        if (!buf) {
          buf = await gitBlobRead(await gitBlobRef(cwd, m.hash as string, path, inside, MEDIA_BLOB_MAX));
          blobKeep(key, buf);
        }
        return { data: buf.subarray(m.offset, m.offset + m.length).toString("base64"), size: buf.length, mtime: 0, mime };
      }));
      return "error" in o ? o.error : (o.result as MediaReadResult);
    }
    const file = allowed(m.path);
    if (!file) return missingInRoots(m.path) ? { code: "not_found", message: `no such file: ${m.path}` } : { code: "path_not_allowed", message: `outside the allowlisted roots: ${m.path}` };
    const fileMime = mediaType(file);
    if (!fileMime) return { code: "unsupported_type", message: `not an image, video or audio file: ${m.path}` };
    let fh;
    try {
      // Same open as GET /media (no-follow, non-blocking: see the ponytail there).
      fh = await open(file, OPEN_READ);
    } catch (err) {
      return { code: "fs_error", message: String(err) };
    }
    try {
      if (!sameFile(fh.fd, file)) return { code: "path_not_allowed", message: `changed during the request: ${m.path}` };
      const st = await fh.stat();
      if (!st.isFile()) return { code: "not_a_file", message: `not a file: ${m.path}` };
      const n = Math.max(0, Math.min(m.length, st.size - m.offset));
      const buf = Buffer.alloc(n);
      const got = n ? (await fh.read(buf, 0, n, m.offset)).bytesRead : 0;
      return { data: buf.subarray(0, got).toString("base64"), size: st.size, mtime: st.mtimeMs, mime: fileMime };
    } finally {
      await fh.close();
    }
  };
  const isPiece = (o: unknown, l: unknown) => Number.isSafeInteger(o) && (o as number) >= 0 && Number.isSafeInteger(l) && (l as number) >= 0 && (l as number) <= MEDIA_CHUNK;
  /** An fs.read/fs.write failure: a path that changed during the request is refused; a directory is not a file. */
  const fsFail = (r: Respond, err: unknown, path: string) => {
    const code = (err as { code?: string }).code;
    if (code === "ECHANGED") return r.fail("path_not_allowed", `changed during the request: ${path}`);
    if (code === "EISDIR") return r.fail("not_a_file", `not a file: ${path}`);
    return r.fail("fs_error", String(err));
  };
  /** fs.write and history.restore: the conflict check, the history entry of the content being replaced, then the write. */
  const writeChecked = (r: Respond, file: string, path: string, content: string, baseMtime: number | undefined, reason: "save" | "restore" = "save") => {
    let fd: number | undefined;
    try {
      fd = openChecked(file, OPEN_WRITE);
      const st = fstatSync(fd);
      if (!st.isFile()) return r.fail("not_a_file", `not a file: ${path}`);
      if (baseMtime !== undefined && st.mtimeMs !== baseMtime) return r.fail("conflict", `changed on disk since it was read: ${path}`);
      localHistory.before(file, reason);
      const data = Buffer.from(content);
      ftruncateSync(fd, 0);
      writeAll(fd, data);
      // Closed first: NTFS may set the write time when the handle closes, and the editor keeps this value as its next baseMtime.
      closeSync(fd);
      fd = undefined;
      clearSearchCache();
      return r.reply({ mtime: statSync(file).mtimeMs });
    } catch (err) {
      return fsFail(r, err, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const list = async (msg: Msg<"fs.list">, res: Respond) => {
    if (msg.path === undefined)
      return res.reply({ entries: roots.map((r): FsEntry => ({ name: r, path: r, isDir: true })) });
    const dir = allowed(msg.path);
    if (!dir) return res.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.path}`);
    try {
      const entries = readdirChecked(dir).map(
        (e): FsEntry => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }),
      );
      return res.reply({ entries: entries.sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ECHANGED") return res.fail("path_not_allowed", "changed during the request");
      return res.fail("fs_error", String(err));
    }
  };

  const search = async (msg: Msg<"fs.search">, res: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd) return res.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (typeof msg.query !== "string") return res.fail("bad_query", "query must be a string");
    // A symlink pointing outside the roots is not offered: the SDK would read its target (like fs.read refuses it).
    return res.reply({ paths: (await searchFiles(cwd, msg.query, 50, (await reposOf(cwd, lastOpen.get(cwd) ?? []).then((r) => r.repos, () => [])), inside)).filter((p) => allowed(join(cwd, p))) });
  };

  const grep = async (msg: Msg<"fs.grep">, res: Respond) => {
    grepping?.abort();
    grepping = undefined;
    const cwd = allowed(msg.cwd);
    if (!cwd) return res.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (typeof msg.query !== "string" || (msg.globs !== undefined && typeof msg.globs !== "string") || [msg.regex, msg.includeIgnored].some((b) => b !== undefined && typeof b !== "boolean")) return res.fail("bad_query", "query and globs must be strings, regex and includeIgnored booleans");
    if (!msg.query.trim()) return res.reply({ files: [], matches: 0, ms: 0, includeIgnored: false, git: false } satisfies FsGrepResult);
    if (msg.query.length > MAX_SEARCH_CHARS) return res.fail("bad_query", `query longer than ${MAX_SEARCH_CHARS} characters`);
    const globs = parseGlobs(msg.globs);
    if (typeof globs === "string") return res.fail("bad_glob", globs);
    const ctl = (grepping = new AbortController());
    try {
      const repos = await reposOf(cwd, lastOpen.get(cwd) ?? []).then((r) => r.repos, () => []);
      const r = await findInFiles(cwd, { query: msg.query, regex: !!msg.regex, globs, includeIgnored: msg.includeIgnored }, { signal: ctl.signal, allowed: (p) => !!allowed(p), repoAllowed: inside, repos });
      // No query text in the log (it may hold a secret).
      console.log(`fs.grep: ${r.files.length} files, ${r.matches} matches, ${r.ms} ms${r.stopped ? `, stopped: ${r.stopped}` : ""}`);
      return res.reply(r);
    } catch (e) {
      return res.fail(e instanceof GrepError ? e.code : "fs_error", (e as Error).message);
    } finally {
      if (grepping === ctl) grepping = undefined;
    }
  };

  const replace = async (msg: Msg<"fs.replace" | "fs.replaceUndo">, res: Respond) => {
    const isUndo = msg.type === "fs.replaceUndo";
    const dry = !isUndo && msg.dryRun === true;
    if (dry) {
      replacing?.abort();
      replacing = undefined;
    }
    const cwd = allowed(msg.cwd);
    if (!cwd) return res.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    const strs = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string");
    if (isUndo) {
      if (typeof msg.id !== "string" || msg.id.length > 100 || (msg.unsaved !== undefined && !strs(msg.unsaved, 200))) return res.fail("bad_request", "id must be a string and unsaved at most 200 strings");
    } else {
      if (typeof msg.query !== "string" || !msg.query.trim() || msg.query.length > MAX_SEARCH_CHARS) return res.fail("bad_request", `query must be a non-blank string of at most ${MAX_SEARCH_CHARS} characters`);
      if (typeof msg.replace !== "string" || [msg.regex, msg.dryRun].some((b) => b !== undefined && typeof b !== "boolean")) return res.fail("bad_request", "replace must be a string, regex and dryRun booleans");
      const files: unknown = msg.files;
      const lineCount = Array.isArray(files) ? files.reduce((n: number, f: { lines?: unknown[] }) => n + (Array.isArray(f?.lines) ? f.lines.length : Infinity), 0) : Infinity;
      if (!Array.isArray(files) || files.length < 1 || files.length > GREP_LIMITS.files || lineCount > GREP_LIMITS.matches)
        return res.fail("bad_request", `files must list 1 to ${GREP_LIMITS.files} files and at most ${GREP_LIMITS.matches} lines`);
      const okFile = (f: { path?: unknown; lines?: unknown; mtime?: unknown; size?: unknown }) =>
        typeof f?.path === "string" && Array.isArray(f.lines) && f.lines.every((n) => Number.isSafeInteger(n) && (n as number) >= 1) && [f.mtime, f.size].every((v) => v === undefined || typeof v === "number");
      if (!files.every(okFile)) return res.fail("bad_request", "each file needs a path, line numbers from 1, and numeric mtime and size");
      try {
        matcher(msg.query, !!msg.regex);
      } catch (e) {
        return res.fail("bad_regex", (e as Error).message);
      }
    }
    if (!dry) {
      if (writingReplace) return res.fail("busy", "Another replace or undo is running");
      writingReplace = true;
    }
    const ctl = dry ? (replacing = new AbortController()) : undefined;
    const o = { allowed, snapshot: (f: string, why: "replace" | "restore") => localHistory.before(f, why), undo: replaceUndo, afterWrite: clearSearchCache };
    try {
      const r = isUndo ? await undoReplace(cwd, msg.id, msg.unsaved ?? [], o) : await replaceInFiles(cwd, { query: msg.query, regex: !!msg.regex, replace: msg.replace, dryRun: dry, files: msg.files }, { ...o, signal: ctl?.signal });
      // Counts only: the query and the replacement may hold a secret.
      console.log(`${msg.type}${dry ? " (dry run)" : ""}: ${r.files.length} files listed, ${r.changedFiles} changed, ${r.changedLines} lines`);
      return res.reply(r);
    } catch (e) {
      return res.fail(e instanceof ReplaceError ? e.code : "fs_error", (e as Error).message);
    } finally {
      if (!dry) writingReplace = false;
      if (ctl && replacing === ctl) replacing = undefined;
    }
  };

  const read = async (msg: Msg<"fs.read">, r: Respond) => {
    // GH-807: a visualize file of a session's upload folder is readable without a root covering that folder.
    const file = allowed(msg.path) ?? visualizeReadable(msg.path, uploads.parent);
    // A missing file whose nearest existing ancestor is allowed (deleted after an Edit, also with its directory): the changes tab shows it deleted.
    if (!file && missingInRoots(msg.path)) return r.fail("not_found", `no such file: ${msg.path}`);
    if (!file) return r.fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
    let fd: number | undefined;
    try {
      fd = openChecked(file, OPEN_READ);
      const st = fstatSync(fd);
      if (!st.isFile()) return r.fail("not_a_file", `not a file: ${msg.path}`);
      if (st.size > MAX_FILE_BYTES) return r.fail("too_large", `larger than ${MAX_FILE_BYTES} bytes: ${msg.path}`, st.size);
      const t = decodeText(readAll(fd, st.size));
      if ("code" in t) return r.fail(t.code, `${t.code === "binary" ? "binary file" : "not UTF-8 text"}: ${msg.path}`, st.size);
      const content = t.content;
      return r.reply({ content, mtime: st.mtimeMs });
    } catch (err) {
      return fsFail(r, err, msg.path);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  const mediaRead = async (msg: Msg<"media.read">, res: Respond) => {
    if (!isPiece(msg.offset, msg.length)) return res.fail("bad_request", `offset and length must be integers, length at most ${MEDIA_CHUNK}`);
    const r = await readMedia(msg);
    return "code" in r ? res.fail(r.code, r.message, r.size) : res.reply(r);
  };

  const fsMedia = async (msg: Msg<"fs.media">, res: Respond) => {
    if (msg.hash !== undefined) {
      const r = await readMedia({ ...msg, offset: 0, length: 0 });
      if ("code" in r) return res.fail(r.code, r.message, r.size);
      const nonce = conn.nonceFor(`blob\0${allowed(msg.cwd)}\0${msg.hash}\0${msg.path}`);
      const args = { path: msg.path, cwd: msg.cwd, hash: msg.hash };
      const read: MediaRead = (offset, length) => readMedia({ ...args, offset, length }).then((x) => ("code" in x ? undefined : x));
      const name = msg.path.split(/[\\/]/).pop() ?? "";
      media.set(nonce, { src: { kind: "bytes", read, mime: r.mime, name }, ws: conn.ws, used: Date.now() });
      return res.reply({ url: `/media/${nonce}/${encodeURIComponent(name)}?v=${msg.hash}`, mime: r.mime, size: r.size, mtime: 0 });
    }
    const file = allowed(msg.path);
    if (!file && missingInRoots(msg.path)) return res.fail("not_found", `no such file: ${msg.path}`);
    if (!file) return res.fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
    try {
      const st = statSync(file);
      if (!st.isFile()) return res.fail("not_a_file", `not a file: ${msg.path}`);
      const mime = mediaType(file);
      if (!mime) return res.fail("unsupported_type", `not an image, video or audio file: ${msg.path}`);
      const nonce = conn.nonceFor(file);
      media.set(nonce, { src: { kind: "file", path: file }, ws: conn.ws, used: Date.now() });
      return res.reply({ url: `/media/${nonce}/${encodeURIComponent(basename(file))}?v=${st.mtimeMs}`, mime, size: st.size, mtime: st.mtimeMs });
    } catch (err) {
      return res.fail("fs_error", String(err));
    }
  };

  const openExternal = async (msg: Msg<"fs.openExternal">, r: Respond) => {
    if (!opts.openExternal) return r.fail("unknown_type", "fs.openExternal is not available here");
    if (!isOpenWith(msg.with)) return r.fail("bad_request", `unknown with: ${String(msg.with)}`);
    const root = allowed(msg.cwd);
    if (!root) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${String(msg.cwd)}`);
    const target = allowed(msg.path);
    if (!target) return missingInRoots(msg.path) ? r.fail("not_found", `no such file: ${msg.path}`) : r.fail("path_not_allowed", `outside the allowlisted roots: ${String(msg.path)}`);
    try {
      const isDir = statSync(target).isDirectory();
      if (msg.with === "default" && isDir) return r.fail("bad_request", "a folder has no default app");
      if (msg.with === "custom") {
        // From the hub's own settings, never from the message.
        const argv = parseEditorCommand(appSettings.get().editor.command);
        const env = process.env;
        try {
          await opts.openExternal.run(customCommand(argv, target, root, isDir, process.platform, (n) => findOnPath({ platform: process.platform, env, exists: existsSync }, n)));
        } catch (err) {
          return r.fail((err as { code?: string }).code === "editor_missing" ? "editor_missing" : "open_failed", (err as Error).message);
        }
        return r.reply({});
      }
      const launcher = msg.with === "reveal" || msg.with === "default" ? undefined : opts.openExternal.editors().get(msg.with);
      if (msg.with !== "reveal" && msg.with !== "default" && !launcher) return r.fail("editor_missing", `${EDITORS[msg.with].label} is not installed`);
      const wslPath = msg.with === "reveal" || msg.with === "default" ? await opts.openExternal.winPath?.(target) : undefined;
      await opts.openExternal.run(openCommand(process.platform, msg.with, target, root, isDir, launcher, wslPath));
      return r.reply({});
    } catch (err) {
      return r.fail("open_failed", (err as Error).message);
    }
  };

  const write = async (msg: Msg<"fs.write">, r: Respond) => {
    // Existing files only: the editor edits what the tree shows.
    const file = allowed(msg.path);
    if (!file) return r.fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
    if (typeof msg.content !== "string") return r.fail("bad_content", "content must be a string");
    return writeChecked(r, file, msg.path, msg.content, msg.baseMtime);
  };

  const historyRequest = async (msg: Msg<"history.list" | "history.read" | "history.restore" | "history.rename" | "history.delete" | "history.create">, r: Respond) => {
    try {
      if (msg.type === "history.list") return r.reply({ entries: await localHistory.list(msg.path) });
      if (msg.type === "history.create") return r.reply({ entry: await localHistory.create(msg.path, msg.label) });
      if (typeof msg.id !== "string") return r.fail("bad_request", "id must be a string");
      if (msg.type === "history.read") return r.reply({ content: await localHistory.read(msg.path, msg.id) });
      if (msg.type === "history.rename") return await localHistory.rename(msg.path, msg.id, msg.label), r.reply({});
      if (msg.type === "history.delete") return await localHistory.remove(msg.path, msg.id), r.reply({});
      const content = await localHistory.read(msg.path, msg.id);
      const file = allowed(msg.path)!;
      // The conflict check comes first inside writeChecked; the current content is snapshotted there, with reason restore.
      return writeChecked(r, file, msg.path, content, msg.baseMtime, "restore");
    } catch (e) {
      if (e instanceof HistoryError) return r.fail(e.code, e.message);
      throw e;
    }
  };

  const create = async (msg: Msg<"fs.create">, res: Respond) => {
    const r = createEntry(fsOps, msg.path, msg.dir === true);
    if (!("code" in r)) clearSearchCache();
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const rename = async (msg: Msg<"fs.rename">, res: Respond) => {
    if (msg.dir !== undefined && typeof msg.dir !== "string") return res.fail("bad_request", "dir must be a string");
    const r = await renameEntry(fsOps, msg.path, msg.name, msg.dir, msg.replace === true, (f) => localHistory.before(f, "paste"));
    if (!("code" in r)) clearSearchCache();
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const remove = async (msg: Msg<"fs.delete">, res: Respond) => {
    const r = await deleteEntry(fsOps, msg.path, msg.dryRun === true);
    if (!("code" in r)) clearSearchCache();
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const walk = async (msg: Msg<"fs.walk">, res: Respond) => {
    const r = await walkEntry(fsOps, msg.path);
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const copy = async (msg: Msg<"fs.copy">, res: Respond) => {
    const r = await copyEntry(fsOps, msg.from, msg.to);
    if (!("code" in r)) clearSearchCache();
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const readChunk = async (msg: Msg<"fs.readChunk">, res: Respond) => {
    if (!Number.isSafeInteger(msg.offset) || msg.offset < 0 || !Number.isSafeInteger(msg.length) || msg.length < 1 || msg.length > CHUNK_BYTES) return res.fail("bad_request", "offset and length must be integers, length 1..CHUNK_BYTES");
    const r = await readFileChunk(fsOps, msg.path, msg.offset, msg.length);
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const writeChunk = async (msg: Msg<"fs.writeChunk">, res: Respond) => {
    if (!Number.isSafeInteger(msg.offset) || msg.offset < 0 || typeof msg.data !== "string" || msg.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 + 4) return res.fail("bad_request", "offset must be an integer, data a base64 string of at most CHUNK_BYTES");
    if (msg.mode !== undefined && !Number.isSafeInteger(msg.mode)) return res.fail("bad_request", "mode must be an integer");
    const r = await writeFileChunk(fsOps, msg.path, msg.offset, Buffer.from(msg.data, "base64"), msg.mode);
    if (!("code" in r) && msg.offset === 0) clearSearchCache();
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const duplicate = async (msg: Msg<"fs.duplicate">, res: Respond) => {
    const r = await duplicateFile(fsOps, msg.path);
    if (!("code" in r)) clearSearchCache();
    return "code" in r ? res.fail(r.code, r.message) : res.reply(r);
  };

  const watch = async (msg: Msg<"fs.watch">, res: Respond) => {
    if (!Array.isArray(msg.paths)) return res.fail("bad_paths", "paths must be an array");
    // Only the diff: re-arming a kept path would take a new stat baseline and drop a change made since the last poll.
    for (const [path, w] of watched)
      if (!msg.paths.includes(path)) {
        unwatchFile(w.real, w.listener);
        watched.delete(path);
      }
    for (const path of msg.paths) {
      const canon = allowed(path);
      if (!canon || watched.has(path)) continue;
      // Parent folder dev/ino (not the file's: an atomic rename-write changes the file's inode).
      const dir = dirname(canon);
      let id;
      try {
        id = statSync(dir, { bigint: true });
      } catch {
        continue;
      }
      // GH-323: a link or swapped folder ends the watch, nothing is sent. A deleted file (real undefined) still reports.
      const listener = (curr: Stats, prev: Stats) => {
        const r = real(canon);
        const now = statSync(dir, { bigint: true, throwIfNoEntry: false });
        if ((r !== undefined && r !== canon) || !now || now.dev !== id.dev || now.ino !== id.ino) {
          unwatchFile(canon, listener);
          watched.delete(path);
        } else if (curr.mtimeMs !== prev.mtimeMs) conn.send({ type: "fs.changed", path, mtime: curr.mtimeMs });
      };
      watchFile(canon, { interval: WATCH_INTERVAL_MS }, listener);
      watched.set(path, { real: canon, listener });
    }
    return res.reply({ watching: [...watched.keys()] });
  };

  const handlers: Handlers<FilesTypes> = {
    "fs.list": list,
    "fs.search": search,
    "fs.grep": grep,
    "fs.replace": replace,
    "fs.replaceUndo": replace,
    "fs.read": read,
    "media.read": mediaRead,
    "fs.media": fsMedia,
    "fs.openExternal": openExternal,
    "fs.write": write,
    "history.list": historyRequest,
    "history.read": historyRequest,
    "history.restore": historyRequest,
    "history.rename": historyRequest,
    "history.delete": historyRequest,
    "history.create": historyRequest,
    "fs.create": create,
    "fs.rename": rename,
    "fs.delete": remove,
    "fs.walk": walk,
    "fs.copy": copy,
    "fs.readChunk": readChunk,
    "fs.writeChunk": writeChunk,
    "fs.duplicate": duplicate,
    "fs.watch": watch,
  };
  return {
    handlers,
    close() {
      blobs.clear();
      unwatchAll();
      grepping?.abort();
      replacing?.abort();
    },
  };
}
