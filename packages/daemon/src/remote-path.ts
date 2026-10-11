import { win32 } from "node:path";

/**
 * Windows paths that make the OS contact another host (SMB, WebDAV: the login's NTLM hash goes with the request) or reach a
 * device namespace. Checked on the string, before any file call. Portable: uses `path.win32`, so tests run anywhere.
 */
export type WinPathKind = "device" | "unc" | "other";

export function winPathKind(p: string): WinPathKind {
  if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(p) || /^[\\/]\?\?[\\/]/.test(p)) return "device";
  if (/^[\\/]{2}[^\\/?.]/.test(p)) return "unc";
  return "other";
}

const norm = (p: string) => win32.resolve(p).toLowerCase();

/** Lower-cased `\\host\share` of a UNC path; undefined for any other path. */
export function uncShare(p: string): string | undefined {
  if (winPathKind(p) !== "unc") return undefined;
  const m = /^\\\\[^\\]+\\[^\\]+/.exec(norm(p));
  return m ? m[0] : norm(p);
}

/** `p` lies in or equals `root`, compared lexically (`..` and mixed slashes resolved, case-insensitive). */
export function insideLexically(p: string, root: string): boolean {
  const a = norm(p);
  const r = norm(root).replace(/\\+$/, "");
  return a === r || a.startsWith(`${r}\\`);
}

/** A client-supplied path that must not reach the file system: NUL, a device path, or a UNC path outside every UNC root. Only on Windows. */
export function refusedPath(p: string, uncRoots: readonly string[], platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  if (p.includes("\0")) return true;
  const kind = winPathKind(p);
  if (kind === "device") return true;
  return kind === "unc" && !uncRoots.some((r) => insideLexically(p, r));
}

/**
 * A pointer read from a repository (`gitdir:`, `commondir`, alternates, a worktree's `gitdir`): a device path, or a UNC path
 * to another share than `base` (a non-UNC base: any UNC value). The same share is data already read from there. Only on Windows.
 */
export function foreignPointer(value: string, base: string, platform: string = process.platform): boolean {
  if (platform !== "win32") return false;
  const kind = winPathKind(value);
  if (kind === "device") return true;
  return kind === "unc" && uncShare(value) !== uncShare(base);
}
