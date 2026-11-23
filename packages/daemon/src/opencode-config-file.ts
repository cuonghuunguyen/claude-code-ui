// The project config file of OpenCode 1 (opencode.json / opencode.jsonc): located and edited by the daemon, because `PATCH /config` writes a file OpenCode does not read.
// Edits keep the user's comments and layout (jsonc-parser). A file that does not parse is never written.
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser";

/** The files OpenCode 1.19.5 reads in a project, lowest precedence first (checked with the real binary: later files override earlier ones key by key). */
const FILES = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
const SCHEMA = "https://opencode.ai/config.json";

export class ConfigFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The existing project config files of `cwd`, lowest precedence first. */
export const projectFiles = (cwd: string) => FILES.map((f) => join(cwd, f)).filter((f) => existsSync(f));

/** The file a write goes to: the one that wins (highest precedence), else a new `<cwd>/opencode.json`. */
export const writeTarget = (cwd: string) => projectFiles(cwd).at(-1) ?? join(cwd, "opencode.json");

/** The parsed content of a file; a file that does not parse is refused with the parse error. */
function read(file: string): { text: string; data: Record<string, unknown> } {
  const text = existsSync(file) ? readFileSync(file, "utf8") : `{\n  "$schema": "${SCHEMA}"\n}\n`;
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new ConfigFileError("config_invalid", `${file} does not parse (${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}). Fix it and try again.`);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new ConfigFileError("config_invalid", `${file} is not a JSON object.`);
  return { text, data: data as Record<string, unknown> };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/**
 * The key set a config file is written in. OpenCode 2 reads the OpenCode 1 shape too (it normalises `mcp.<n>`, `permission` and `plugin`), so a file is "v2" only when it
 * already uses the OpenCode 2 keys: `mcp.servers`, a `permissions` list or `plugins`. An empty or new file is "v1": the unchanged OpenCode 1 writers apply.
 */
export function shapeOf(data: Record<string, unknown>): "v1" | "v2" {
  const mcp = data.mcp;
  if (isObject(mcp) && isObject(mcp.servers) && typeof mcp.servers.type !== "string") return "v2";
  return Array.isArray(data.permissions) || Array.isArray(data.plugins) ? "v2" : "v1";
}
export const fileShape = (file: string): "v1" | "v2" => (existsSync(file) ? shapeOf(read(file).data) : "v1");
/** The existing project config files of `cwd` with their parsed content, lowest precedence first. */
export const projectDocs = (cwd: string) => projectFiles(cwd).map((file) => ({ file, data: read(file).data }));

/** The value at `path` in the merged project files (the winning file's value for each key), or undefined. */
export function readProjectValue(cwd: string, path: (string | number)[]): unknown {
  let found: unknown;
  for (const f of projectFiles(cwd)) {
    let v: unknown = read(f).data;
    for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[String(k)] : undefined;
    if (v !== undefined) found = v;
  }
  return found;
}

/** The keys of the object at `path`, over every project file. */
export function projectKeys(cwd: string, path: (string | number)[]): Set<string> {
  const keys = new Set<string>();
  for (const f of projectFiles(cwd)) {
    let v: unknown = read(f).data;
    for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[String(k)] : undefined;
    if (v !== null && typeof v === "object") for (const k of Object.keys(v)) keys.add(k);
  }
  return keys;
}

const has = (data: Record<string, unknown>, path: (string | number)[]) => {
  let v: unknown = data;
  for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[String(k)] : undefined;
  return v !== undefined;
};

function write(link: string, path: (string | number)[], value: unknown, insert = false) {
  // A symlinked config file (dotfiles) stays a link: the real file is replaced, with its mode.
  const file = existsSync(link) ? realpathSync(link) : link;
  const { text } = read(file);
  const next = applyEdits(text, modify(text, path, value, { isArrayInsertion: insert, formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next, existsSync(file) ? { mode: statSync(file).mode & 0o777 } : undefined);
  renameSync(tmp, file);
}

/**
 * Sets (`value` given) the value at `path` in the winning project file, or deletes it (`undefined`) from every project file that has it (a lower file would otherwise show it again).
 * Every file is parsed before the first write: one that does not parse stops the edit with nothing written. Atomic per file (temp file + rename in the same folder).
 */
export function editProjectFile(cwd: string, path: (string | number)[], value: unknown): string[] {
  const files = value === undefined ? projectFiles(cwd).filter((f) => has(read(f).data, path)) : [writeTarget(cwd)];
  for (const f of files) read(f);
  for (const f of files) write(f, path, value);
  return files;
}

/** Sets (`value` given) or deletes (`undefined`) the value at `path` in one file (not parsing is refused, nothing written). */
export function editFileAt(file: string, path: (string | number)[], value: unknown) {
  read(file);
  write(file, path, value);
}

/** The entries of the list at `path` in each project file that has one, lowest precedence first (OpenCode joins the lists of its config files). A key that is not a list is refused. */
export function projectLists(cwd: string, path: string[]): { file: string; items: unknown[] }[] {
  return projectFiles(cwd).flatMap((file) => {
    let v: unknown = read(file).data;
    for (const k of path) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new ConfigFileError("config_invalid", `${file}: "${path.join(".")}" is not a list. Fix it and try again.`);
    return [{ file, items: v }];
  });
}

/**
 * Appends `value` to the list at `path` of the winning project file (the list is created when no file has one in it), or removes from every project file
 * the entries `drop` accepts. Same rules as `editProjectFile`: every file is parsed first, atomic per file, comments and layout kept. Returns the files written.
 */
export function editProjectList(cwd: string, path: string[], change: { append: unknown } | { drop: (item: unknown, file: string) => boolean }): string[] {
  const lists = projectLists(cwd, path);
  if ("append" in change) {
    const file = writeTarget(cwd);
    read(file);
    const own = lists.find((l) => l.file === file);
    write(file, own ? [...path, own.items.length] : path, own ? change.append : [change.append], !!own);
    return [file];
  }
  const done: string[] = [];
  for (const l of lists) {
    const at = l.items.flatMap((item, i) => (change.drop(item, l.file) ? [i] : []));
    // From the end: an earlier index stays valid after a later one is removed.
    for (const i of at.reverse()) write(l.file, [...path, i], undefined);
    if (at.length) done.push(l.file);
  }
  return done;
}
