import { lstatSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** A file name the visualize skill writes: `<name>.html`, no folder, not hidden. */
const NAME = /^[A-Za-z0-9][\w.-]*\.html$/;

const lstat = (p: string): Stats | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * Whether a tool call is the visualize skill writing its HTML (GH-807): `Write` of `<uploads>/visualize/<name>.html`, `uploads` being
 * the session's upload folder the CLI was granted. Such a call runs without a permission card in every mode.
 * Refused (the call asks as before): any other tool or folder, `.`/`..` segments, a symlinked `visualize` folder or target, a target
 * with more than one hard link (a write would change the file elsewhere), a target that is no regular file.
 * The path is checked as written and against the folder's real path (macOS `/tmp` -> `/private/tmp`); it is not resolved first.
 */
export function isVisualizeWrite(tool: string, input: Record<string, unknown>, uploads: string | undefined): boolean {
  if (tool !== "Write" || !uploads) return false;
  const path = input.file_path;
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return false;
  if (path.split(/[\\/]/).some((s) => s === "." || s === "..")) return false;
  const file = resolve(path);
  if (!NAME.test(basename(file))) return false;
  const dir = dirname(file);
  const root = real(uploads);
  if (!root || ![join(uploads, "visualize"), join(root, "visualize")].includes(dir)) return false;
  const d = lstat(dir);
  if (d && (!d.isDirectory() || real(dir) !== join(root, "visualize"))) return false;
  const f = lstat(file);
  return !f || (f.isFile() && f.nlink === 1);
}

/**
 * The real path of a visualize file `fs.read` may read although no root covers the upload folder (GH-807): an existing
 * `<uploadsParent>/<session id>/visualize/<name>.html` that passes `isVisualizeWrite`. Read only; fs.write keeps the roots.
 */
export function visualizeReadable(path: unknown, uploadsParent: string): string | undefined {
  if (typeof path !== "string" || !isAbsolute(path)) return undefined;
  const session = dirname(dirname(resolve(path)));
  const parent = real(uploadsParent);
  if (!parent || ![uploadsParent, parent].includes(dirname(session)) || basename(session).startsWith(".")) return undefined;
  const s = lstat(session);
  if (!s?.isDirectory() || real(session) !== join(parent, basename(session))) return undefined;
  if (!lstat(path)?.isFile() || !isVisualizeWrite("Write", { file_path: path }, session)) return undefined;
  return real(path);
}
