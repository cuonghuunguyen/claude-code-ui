// Paths as the daemon's OS writes them. The web app does not know that OS: a drive letter or UNC prefix marks a Windows path,
// which takes "\" and "/" as separators and compares without case (NTFS); every other path is POSIX.

export const isWinPath = (p: string) => /^(?:[a-z]:|\\\\)/i.test(p);

/** The separator of absolute `p`'s OS. */
export const sepOf = (p: string) => (isWinPath(p) ? "\\" : "/");

/** Last segment, split on "/" and "\" (a relative Windows path carries no drive letter to tell). */
export const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;

/** `path` is `dir` or inside it. */
export function inDir(path: string, dir: string) {
  const norm = isWinPath(dir) ? (s: string) => s.replace(/\//g, "\\").toLowerCase() : (s: string) => s;
  const [p, d] = [norm(path), norm(dir)];
  return p === d || p.startsWith(withSep(d));
}

/** `path` relative to `cwd` when inside it, else unchanged. */
export function relPath(path: string, cwd: string) {
  const root = cwd.replace(isWinPath(cwd) ? /[\\/]$/ : /\/$/, "");
  return root && path.length > root.length && inDir(path, root) ? path.slice(root.length + 1) : path;
}

/** `dir` ending with its separator. */
export const withSep = (dir: string) => (dir.endsWith(sepOf(dir)) || (isWinPath(dir) && dir.endsWith("/")) ? dir : dir + sepOf(dir));

/** `rel` ("/"-separated, as fs.search answers) under absolute `dir`, in `dir`'s separators. */
export const joinPath = (dir: string, rel: string) => withSep(dir) + (isWinPath(dir) ? rel.replace(/\//g, "\\") : rel);
