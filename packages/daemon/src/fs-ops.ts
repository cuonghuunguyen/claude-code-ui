import { closeSync, type Stats, constants, fstatSync, lstatSync, mkdirSync, openSync, read, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, write } from "node:fs";
import { opendir, open, rm, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { CHUNK_BYTES, copyName, fileNameError, TRANSFER_MAX_BYTES, TRANSFER_MAX_ENTRIES, type FsChunkResult, type FsDeleteResult, type FsPathResult, type FsWalkEntry, type FsWalkResult } from "@claude-ui/protocol";
import { openChecked, OPEN_READ, OPEN_WRITE, real } from "./fd-check.ts";

export { copyName };

/** What the file tree operations need from the daemon (no WebSocket: tests call the operations directly). */
export type FsOpsContext = {
  /** The canonical path when it is an existing path inside a root. */
  allowed: (p: unknown) => string | undefined;
  /** A UNC / device path that may not reach the file system (GH-282). */
  refused: (p: string) => boolean;
  /** A missing path whose nearest existing ancestor is allowed. */
  missingInRoots: (p: unknown) => boolean;
  /** Canonical roots. */
  roots: string[];
  /** A live session's cwd (or a worktree being removed) is this path or below it. */
  busy: (target: string) => boolean;
};
export type Failure = { code: string; message: string };
export type FsOpResult<T> = T | Failure;

/** Largest file fs.duplicate copies. */
export const DUPLICATE_MAX = 512 * 1024 * 1024;
const CHUNK = CHUNK_BYTES;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const fail = (code: string, message: string): Failure => ({ code, message });
const isFailure = (x: unknown): x is Failure => typeof (x as Failure | undefined)?.code === "string" && typeof (x as Failure).message === "string";
const win = () => process.platform === "win32";

/** An fs error as a refusal. */
function fsFailure(err: unknown, path: string): Failure {
  const code = (err as { code?: string }).code;
  switch (code) {
    case "EEXIST":
      return fail("exists", `already exists: ${path}`);
    case "ENOENT":
      return fail("not_found", `no such file or folder: ${path}`);
    case "ECHANGED":
    case "ELOOP":
      return fail("path_not_allowed", `changed during the request: ${path}`);
    case "EISDIR":
      return fail("not_a_file", `not a file: ${path}`);
    default:
      return fail("fs_error", String(err instanceof Error ? err.message : err));
  }
}

/** Steps 1-3 of the security rules: the canonical parent and the target (the last component is never resolved), or the refusal. */
function resolve(ctx: FsOpsContext, path: unknown): { parent: string; target: string; name: string } | Failure {
  if (typeof path !== "string" || path === "") return fail("path_not_allowed", "outside the allowlisted roots");
  const name = basename(path);
  const bad = fileNameError(name, win());
  if (bad) return fail("bad_name", bad);
  if (ctx.refused(path) || !isAbsolute(path)) return fail("path_not_allowed", `outside the allowlisted roots: ${path}`);
  const parent = ctx.allowed(dirname(path));
  if (!parent) {
    return ctx.missingInRoots(dirname(path)) ? fail("not_found", `no such folder: ${dirname(path)}`) : fail("path_not_allowed", `outside the allowlisted roots: ${path}`);
  }
  try {
    if (!statSync(parent).isDirectory()) return fail("not_a_dir", `not a folder: ${parent}`);
  } catch (err) {
    return fsFailure(err, parent);
  }
  return { parent, target: join(parent, name), name };
}

/** A project root given as its canonical path (its parent is outside the roots, so the parent check would say "outside"). */
const isRoot = (ctx: FsOpsContext, path: unknown) => typeof path === "string" && ctx.roots.includes(path);

/** The parent swapped for a link (or moved) since the check: refused before anything changes. */
const parentChanged = (parent: string) => real(parent) !== parent;
const changed = (path: string) => fail("path_not_allowed", `changed during the request: ${path}`);

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** New empty file, or one-level folder. */
export function createEntry(ctx: FsOpsContext, path: string, dir: boolean): FsOpResult<FsPathResult> {
  const r = resolve(ctx, path);
  if (isFailure(r)) return r;
  if (exists(r.target)) return fail("exists", `already exists: ${r.target}`);
  if (parentChanged(r.parent)) return changed(path);
  try {
    if (dir) mkdirSync(r.target);
    else closeSync(openSync(r.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o666));
    return { path: r.target };
  } catch (err) {
    return fsFailure(err, r.target);
  }
}

/** A new name in the same folder, or (`dir`) in another folder; `replace` replaces an existing target. `history`: called with a file about to be replaced. */
export async function renameEntry(ctx: FsOpsContext, path: string, name: string, dir?: string, replace = false, history?: (file: string) => void): Promise<FsOpResult<FsPathResult>> {
  if (typeof name !== "string") return fail("bad_name", "A name is required.");
  const bad = fileNameError(name, win());
  if (bad) return fail("bad_name", bad);
  if (isRoot(ctx, path)) return fail("root_protected", `a project root cannot be renamed: ${path}`);
  const r = resolve(ctx, path);
  if (isFailure(r)) return r;
  let from;
  try {
    from = lstatSync(r.target, { bigint: true });
  } catch (err) {
    return fsFailure(err, r.target);
  }
  if (ctx.busy(r.target)) return fail("in_use", `a session works in ${r.target}`);
  let folder = r.parent;
  if (dir !== undefined) {
    const d = ctx.allowed(dir);
    if (!d) return ctx.missingInRoots(dir) ? fail("not_found", `no such folder: ${dir}`) : fail("path_not_allowed", `outside the allowlisted roots: ${dir}`);
    try {
      if (!statSync(d).isDirectory()) return fail("not_a_dir", `not a folder: ${d}`);
    } catch (err) {
      return fsFailure(err, d);
    }
    if (d === r.target || d.startsWith(r.target + sep)) return fail("into_itself", `a folder cannot go into itself: ${r.target}`);
    folder = d;
  }
  const to = join(folder, name);
  let old;
  try {
    const other = lstatSync(to, { bigint: true });
    // Same device and inode and the same name up to case: a case-only rename on a case-insensitive file system.
    // Another name with the same inode is a hard link: the rename would do nothing.
    const same = other.dev === from.dev && other.ino === from.ino;
    if (!same || folder !== r.parent || name.toLowerCase() !== r.name.toLowerCase()) {
      if (!replace || same) return fail("exists", `already exists: ${to}`);
      if (ctx.busy(to)) return fail("in_use", `a session works in ${to}`);
      old = other;
    }
  } catch {
    // free
  }
  if (parentChanged(r.parent) || parentChanged(folder)) return changed(path);
  try {
    if (old && !(old.isFile() && !from.isDirectory())) {
      // The old folder (or a kind change) goes aside first; a failed rename puts it back.
      const aside = join(folder, `.${name}.replaced-${randomBytes(3).toString("hex")}`);
      renameSync(to, aside);
      try {
        renameSync(r.target, to);
      } catch (err) {
        renameSync(aside, to);
        throw err;
      }
      await rm(aside, { recursive: true, force: true, maxRetries: 3 });
    } else {
      if (old) history?.(to);
      renameSync(r.target, to);
    }
    return { path: to };
  } catch (err) {
    return fsFailure(err, to);
  }
}

/** Entries below the folder: links count as files and are never entered. Stops at `limit` entries or `ms` milliseconds. */
export async function countEntries(dir: string, limit = 10_000, ms = 2000): Promise<FsDeleteResult> {
  const end = Date.now() + ms;
  let files = 0;
  let folders = 0;
  let more = false;
  const queue = [dir];
  while (queue.length && !more) {
    const d = queue.pop()!;
    let handle;
    try {
      handle = await opendir(d);
    } catch {
      continue;
    }
    try {
      for await (const e of handle) {
        if (files + folders >= limit || Date.now() > end) {
          more = true;
          break;
        }
        if (e.isDirectory()) (folders++, queue.push(join(d, e.name)));
        else files++;
      }
    } catch {
      // unreadable: counted as far as it goes
    }
  }
  return more ? { files, folders, more: true } : { files, folders };
}

/** Deletes for good; `dryRun` only counts. */
export async function deleteEntry(ctx: FsOpsContext, path: string, dryRun: boolean): Promise<FsOpResult<FsDeleteResult>> {
  if (isRoot(ctx, path)) return fail("root_protected", `a project root cannot be deleted: ${path}`);
  const r = resolve(ctx, path);
  if (isFailure(r)) return r;
  let st;
  try {
    st = lstatSync(r.target);
  } catch (err) {
    return fsFailure(err, r.target);
  }
  if (ctx.busy(r.target)) return fail("in_use", `a session works in ${r.target}`);
  const count = st.isDirectory() ? await countEntries(r.target) : { files: 0, folders: 0 };
  if (dryRun) return count;
  if (parentChanged(r.parent)) return changed(path);
  try {
    if (st.isDirectory()) await rm(r.target, { recursive: true, force: false, maxRetries: 3 });
    else await unlink(r.target);
    return count;
  } catch (err) {
    return fsFailure(err, r.target);
  }
}

/** A copy of a file next to it. */
export async function duplicateFile(ctx: FsOpsContext, path: string): Promise<FsOpResult<FsPathResult>> {
  const r = resolve(ctx, path);
  if (isFailure(r)) return r;
  let src: number | undefined;
  let dest: Awaited<ReturnType<typeof open>> | undefined;
  let made: string | undefined;
  try {
    if (lstatSync(r.target).isSymbolicLink()) return fail("not_a_file", "Cannot duplicate a link.");
    src = openChecked(r.target, OPEN_READ);
    const st = fstatSync(src);
    if (!st.isFile()) return fail("not_a_file", `not a file: ${r.target}`);
    if (st.size > DUPLICATE_MAX) return fail("too_large", `too large to duplicate: ${r.target}`);
    if (parentChanged(r.parent)) return changed(path);
    for (let n = 1; n <= 1000 && !dest; n++) {
      const to = join(r.parent, copyName(r.name, n));
      if (exists(to)) continue;
      try {
        dest = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, st.mode & 0o777);
        made = to;
      } catch (err) {
        if ((err as { code?: string }).code !== "EEXIST") throw err;
      }
    }
    if (!dest || !made) return fail("exists", `no free copy name for ${r.name}`);
    await pump(src, dest);
    await dest.close();
    dest = undefined;
    return { path: made };
  } catch (err) {
    if (made) {
      await dest?.close().catch(() => {});
      dest = undefined;
      try {
        unlinkSync(made);
      } catch {
        // already gone
      }
    }
    return fsFailure(err, r.target);
  } finally {
    if (src !== undefined) closeSync(src);
    await dest?.close().catch(() => {});
  }
}

const readAt = (fd: number, buf: Buffer, position: number, length = buf.length) =>
  new Promise<number>((res, rej) => read(fd, buf, 0, length, position, (e, n) => (e ? rej(e) : res(n))));
const writeAt = (fd: number, buf: Buffer, position: number) =>
  new Promise<void>((res, rej) => write(fd, buf, 0, buf.length, position, (e) => (e ? rej(e) : res())));

/** The whole open file `src` into `dest`. */
async function pump(src: number, dest: Awaited<ReturnType<typeof open>>) {
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let at = 0; ; ) {
    const n = await readAt(src, buf, at);
    if (n === 0) break;
    await dest.write(buf, 0, n);
    at += n;
  }
}

/** Every file, folder and link below `path` (GH-555), `path` first. Links are never entered. Over the limits: `too_many` / `too_large`, before anything is read further. */
export async function walkEntry(ctx: FsOpsContext, path: string, maxEntries = TRANSFER_MAX_ENTRIES, maxBytes = TRANSFER_MAX_BYTES): Promise<FsOpResult<FsWalkResult>> {
  let top: string;
  if (isRoot(ctx, path)) top = path;
  else {
    const r = resolve(ctx, path);
    if (isFailure(r)) return r;
    top = r.target;
  }
  const entries: FsWalkEntry[] = [];
  let bytes = 0;
  const add = (rel: string, st: Stats, abs: string): Failure | undefined => {
    const kind = st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file";
    // Sockets, FIFOs and devices cannot be copied: left out.
    if (!st.isDirectory() && !st.isSymbolicLink() && !st.isFile()) return;
    if (entries.length >= maxEntries) return fail("too_many", `more than ${maxEntries} entries`);
    if (kind === "file") bytes += st.size;
    if (bytes > maxBytes) return fail("too_large", `more than ${maxBytes} bytes`);
    entries.push({ rel, kind, size: kind === "file" ? st.size : 0, mode: st.mode & 0o777, ...(kind === "link" && { target: readlinkSync(abs) }) });
  };
  try {
    const st = lstatSync(top);
    const first = add("", st, top);
    if (first) return first;
    if (!st.isDirectory()) return { entries, bytes };
    if (parentChanged(dirname(top)) && !isRoot(ctx, top)) return changed(path);
    const queue = [""];
    while (queue.length) {
      const rel = queue.shift()!;
      const abs = rel === "" ? top : join(top, ...rel.split("/"));
      const handle = await opendir(abs);
      for await (const e of handle) {
        const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
        const childAbs = join(abs, e.name);
        const cst = lstatSync(childAbs);
        const f = add(childRel, cst, childAbs);
        if (f) return f; // leaving the loop closes the handle
        if (cst.isDirectory()) queue.push(childRel);
      }
    }
    return { entries, bytes };
  } catch (err) {
    return fsFailure(err, top);
  }
}

/** One file or link to a name that does not exist yet, in the same Daemon (GH-555). The partial file is removed on an error. */
export async function copyEntry(ctx: FsOpsContext, from: string, to: string): Promise<FsOpResult<FsPathResult>> {
  const a = resolve(ctx, from);
  if (isFailure(a)) return a;
  const b = resolve(ctx, to);
  if (isFailure(b)) return b;
  let src: number | undefined;
  let dest: Awaited<ReturnType<typeof open>> | undefined;
  let made = false;
  try {
    const lst = lstatSync(a.target);
    if (exists(b.target)) return fail("exists", `already exists: ${b.target}`);
    if (parentChanged(b.parent)) return changed(to);
    if (lst.isSymbolicLink()) {
      symlinkSync(readlinkSync(a.target), b.target);
      return { path: b.target };
    }
    if (!lst.isFile()) return fail("not_a_file", `not a file: ${a.target}`);
    src = openChecked(a.target, OPEN_READ);
    const st = fstatSync(src);
    if (!st.isFile()) return fail("not_a_file", `not a file: ${a.target}`);
    dest = await open(b.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, st.mode & 0o777);
    made = true;
    await pump(src, dest);
    await dest.close();
    dest = undefined;
    return { path: b.target };
  } catch (err) {
    await dest?.close().catch(() => {});
    dest = undefined;
    if (made) {
      try {
        unlinkSync(b.target);
      } catch {
        // already gone
      }
    }
    return fsFailure(err, b.target);
  } finally {
    if (src !== undefined) closeSync(src);
    await dest?.close().catch(() => {});
  }
}

/** Up to `length` bytes of a file from `offset` (GH-555). */
export function readFileChunk(ctx: FsOpsContext, path: string, offset: number, length: number): Promise<FsOpResult<FsChunkResult>> {
  return (async () => {
    const r = resolve(ctx, path);
    if (isFailure(r)) return r;
    let fd: number | undefined;
    try {
      fd = openChecked(r.target, OPEN_READ);
      const st = fstatSync(fd);
      if (!st.isFile()) return fail("not_a_file", `not a file: ${r.target}`);
      const buf = Buffer.allocUnsafe(length);
      const n = await readAt(fd, buf, offset, length);
      return { data: buf.subarray(0, n).toString("base64"), size: st.size };
    } catch (err) {
      return fsFailure(err, r.target);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  })();
}

/** `data` at `offset` (GH-555): offset 0 creates the file (it must not exist), a later piece needs a file of exactly `offset` bytes. */
export async function writeFileChunk(ctx: FsOpsContext, path: string, offset: number, data: Buffer, mode = 0o666): Promise<FsOpResult<{ size: number }>> {
  const r = resolve(ctx, path);
  if (isFailure(r)) return r;
  let fd: number | undefined;
  try {
    if (offset === 0) {
      if (exists(r.target)) return fail("exists", `already exists: ${r.target}`);
      if (parentChanged(r.parent)) return changed(path);
      fd = openSync(r.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, mode & 0o777);
    } else {
      fd = openChecked(r.target, OPEN_WRITE);
      if (!fstatSync(fd).isFile()) return fail("not_a_file", `not a file: ${r.target}`);
      if (fstatSync(fd).size !== offset) return fail("conflict", `the file is not ${offset} bytes long: ${r.target}`);
    }
    await writeAt(fd, data, offset);
    return { size: offset + data.length };
  } catch (err) {
    return fsFailure(err, r.target);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
