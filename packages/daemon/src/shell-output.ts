// Shells list (GH-442): reads the end of a CLI task output file, only from the CLI's own task folder.
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { open } from "node:fs/promises";
import { MAX_BASH_OUTPUT_CHARS } from "./bash.ts";
import { OPEN_READ, real } from "./fd-check.ts";

const TAIL_CHARS = 256 * 1024;

/**
 * The folders the CLI writes session `sessionId`'s task output files in (SDK 0.3.285: <tmp>/claude-<uid>/<cwd slug>/<session>/tasks;
 * older: <tmp>/claude/...). The CLI uses /tmp on macOS, where tmpdir() is /var/folders/...: both are candidates.
 */
export function taskDirs(cwd: string, sessionId: string, tmp = tmpdir()): string[] {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length > 200 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sessionId)) return [];
  const names = [...(process.getuid ? [`claude-${process.getuid()}`] : []), "claude"];
  return [...new Set([tmp, "/tmp"])].flatMap((t) => names.map((n) => resolve(t, n, slug, sessionId, "tasks")));
}

/**
 * The last `max` chars of task output file `path` (stdout and stderr merged). A path the model could have written is never trusted:
 * its real path must lie inside one of `dirs` (a symlink out of them is refused, and the file itself is opened without following links).
 * Undefined when it is outside, or does not exist.
 */
export async function readTail(path: string, dirs: readonly string[], max = MAX_BASH_OUTPUT_CHARS): Promise<{ output: string; truncated: boolean } | undefined> {
  const file = real(path);
  const inside = (d: string) => {
    const r = real(d);
    const rel = r && file ? relative(r, file) : "..";
    return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
  };
  if (!file || !dirs.some(inside)) return undefined;
  const fh = await open(file, OPEN_READ).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return undefined; throw e; });
  if (!fh) return undefined;
  try {
    const st = await fh.stat();
    if (!st.isFile()) return undefined;
    // Bytes: at most 4 per char, capped (a huge file is never read whole).
    const start = Math.max(0, st.size - Math.min(max * 4, TAIL_CHARS));
    const buf = Buffer.alloc(st.size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8", 0, bytesRead);
    const truncated = start > 0 || text.length > max;
    return { output: truncated ? text.slice(-max) : text, truncated };
  } finally {
    await fh.close();
  }
}
