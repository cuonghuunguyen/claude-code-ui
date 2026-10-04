// Open project folder browser: the input is a path inside a root; its last segment filters the folders listed (type-ahead).
import type { FsEntry } from "@claude-ui/protocol";
import { inDir, isWinPath, withSep } from "./paths.ts";

/** The directory to list (`dir`, absent = the roots) and the text that filters its folders. A Windows path also splits on "\\". */
export function browse(input: string, roots: string[]): { dir?: string; prefix: string } {
  const win = isWinPath(input);
  if (roots.some((r) => input === r || input === withSep(r))) return { dir: input.replace(win ? /([^:])[\\/]$/ : /(.)\/$/, "$1"), prefix: "" };
  const cut = win ? Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\")) : input.lastIndexOf("/");
  // A drive root keeps its separator ("C:\\").
  const dir = input.slice(0, win && cut === 2 ? 3 : cut) || "/";
  if (cut < 0 || !roots.some((r) => inDir(dir, r))) return { prefix: input };
  return { dir, prefix: input.slice(cut + 1) };
}

/** Folders whose name starts with `prefix`, then those containing it; dot folders only when the prefix starts with a dot. */
export function matchFolders(entries: FsEntry[], prefix: string) {
  const q = prefix.toLowerCase();
  const dirs = entries.filter((e) => e.isDir && (q.startsWith(".") || !e.name.startsWith(".")));
  const starts = dirs.filter((e) => e.name.toLowerCase().startsWith(q));
  return [...starts, ...dirs.filter((e) => !starts.includes(e) && e.name.toLowerCase().includes(q))];
}
