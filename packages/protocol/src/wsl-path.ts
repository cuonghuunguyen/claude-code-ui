/** A Windows path into a WSL distro (`\\wsl$\Ubuntu\home\me`, `\\wsl.localhost\Ubuntu\...`) as that distro's side and POSIX path. */
export function fromWslUnc(input: string): { side: string; path: string } | undefined {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(.*)$/i.exec(input);
  if (!m) return undefined;
  return { side: `wsl:${m[1]}`, path: m[2]!.replace(/\\/g, "/") || "/" };
}

/** A Windows drive seen from WSL (`/mnt/c/Users/me`) as the Windows path (`C:\Users\me`); undefined for other paths. */
export function fromMnt(path: string) {
  const m = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(path);
  return m ? `${m[1]!.toUpperCase()}:\\${(m[2] ?? "").replace(/\/+$/, "").replace(/\//g, "\\")}` : undefined;
}

/** The WSL distro and POSIX path of a `\\wsl$\<D>\...` / `\\wsl.localhost\<D>\...` path (either slash, any case); `root` is the UNC prefix as written (`\\wsl.localhost\Ubuntu`). Trailing separators dropped; the distro root is `/`. */
export function wslPathOf(p: string): { distro: string; posix: string; root: string } | undefined {
  const m = /^([\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+))(.*)$/i.exec(p);
  if (!m) return undefined;
  return { distro: m[2]!, posix: m[3]!.replace(/\\/g, "/").replace(/\/+$/, "") || "/", root: m[1]!.replace(/\//g, "\\") };
}

/** A POSIX path git in the distro printed, as a Windows path under the same UNC `root` (`/mnt/<x>/...` -> `X:\...`). */
export function wslHostPath(root: string, posix: string): string {
  return fromMnt(posix) ?? (posix === "/" ? `${root}\\` : root + posix.replace(/\//g, "\\"));
}
