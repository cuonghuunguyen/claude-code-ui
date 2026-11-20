// The project config file of OpenCode 1 (opencode.json / opencode.jsonc): located and edited by the daemon, because `PATCH /config` writes a file OpenCode does not read.
// Edits keep the user's comments and layout (jsonc-parser). A file that does not parse is never written.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

function write(file: string, path: (string | number)[], value: unknown) {
  const { text } = read(file);
  const next = applyEdits(text, modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" } }));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
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
