import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, writeSync } from "node:fs";

/** Canonical path (symlinks resolved), or undefined when it does not exist. */
export function real(path: string) {
  try {
    // Windows: only the native call gives the on-disk case (c:\users\me -> C:\Users\me), so one folder is one project.
    return process.platform === "win32" ? realpathSync.native(path) : realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Existing files only (no O_CREAT, no O_TRUNC): nothing is destroyed before the check. No-follow where the OS has it; non-blocking keeps a swapped-in FIFO from blocking the open. */
export const OPEN_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
export const OPEN_WRITE = constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * True when the open file `fd` is the file the canonical path names now: no component is a link (a swapped directory fails
 * the realpath), and device and inode match (a swap and swap back fails here). bigint: Windows file indexes exceed 2^53.
 */
export function sameFile(fd: number, canonical: string): boolean {
  try {
    if (real(canonical) !== canonical) return false;
    const a = fstatSync(fd, { bigint: true });
    const b = statSync(canonical, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** Opens a canonical in-root path once and proves the fd is that file. Mismatch: closes the fd, throws code ECHANGED. */
export function openChecked(canonical: string, flags: number): number {
  const fd = openSync(canonical, flags);
  if (!sameFile(fd, canonical)) {
    closeSync(fd);
    throw Object.assign(new Error("changed during the request"), { code: "ECHANGED" });
  }
  return fd;
}

/** `size` bytes (or up to end of file) read from the start of `fd`. */
export function readAll(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    const n = readSync(fd, buf, got, size - got, got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** `data` written at the start of `fd`. */
export function writeAll(fd: number, data: Buffer): void {
  let at = 0;
  while (at < data.length) at += writeSync(fd, data, at, data.length - at, at);
}
