import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, read, renameSync, statSync, unlinkSync } from "node:fs";
import { opendir, open, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileNameError, type FsDeleteResult, type FsPathResult } from "@claude-ui/protocol";
import { openChecked, OPEN_READ, real } from "./fd-check.ts";

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
const CHUNK = 1024 * 1024;
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

/** A new name in the same folder. */
export async function renameEntry(ctx: FsOpsContext, path: string, name: string): Promise<FsOpResult<FsPathResult>> {
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
  const to = join(r.parent, name);
  try {
    const other = lstatSync(to, { bigint: true });
    // Same device and inode: a case-only rename on a case-insensitive file system.
    if (other.dev !== from.dev || other.ino !== from.ino) return fail("exists", `already exists: ${to}`);
  } catch {
    // free
  }
  if (parentChanged(r.parent)) return changed(path);
  try {
    renameSync(r.target, to);
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

/** "a copy.ts" for n = 1, "a copy 2.ts" for n = 2; the last extension stays last, a dotfile or no extension takes the suffix at the end. */
export function copyName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`;
}

/** A copy of a file next to it. */
export async function duplicateFile(ctx: FsOpsContext, path: string): Promise<FsOpResult<FsPathResult>> {
  const r = resolve(ctx, path);
  if (isFailure(r)) return r;
  let src: number | undefined;
  let dest: Awaited<ReturnType<typeof open>> | undefined;
  let made: string | undefined;
  try {
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
    const buf = Buffer.allocUnsafe(CHUNK);
    for (let at = 0; ; ) {
      const n = await readChunk(src, buf, at);
      if (n === 0) break;
      await dest.write(buf, 0, n);
      at += n;
    }
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

const readChunk = (fd: number, buf: Buffer, position: number) =>
  new Promise<number>((res, rej) => read(fd, buf, 0, buf.length, position, (e, n) => (e ? rej(e) : res(n))));
