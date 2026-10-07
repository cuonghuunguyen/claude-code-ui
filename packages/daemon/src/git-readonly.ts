// Whether a Bash tool call is only read-only git (docs/spec.md "Permission tiers"): the one Bash shape a coordinator may settle.
// An allowlist grammar: one fixed program (git), no quoting, no expansion, no redirection, exact option names. Any doubt = false.
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { deniedRead, pathLow } from "./risk-tier.ts";

/** One option: `value` absent = takes none; else the value must match (when `optional`, the bare option is fine too). */
type Opt = { value: RegExp; optional: boolean } | undefined;
const FLAG: Opt = undefined;
const val = (value: RegExp, optional = false): Opt => ({ value, optional });
const N = /^\d{1,6}$/;
/** A value of `--author=`, `--since=` ...: no space, no `{}`, no leading or inner `~`, no `$ ' " \ * ? [ ]` (the command charset already refuses those). */
const FREE = /^[A-Za-z0-9._/@^:=,+%-]{1,200}$/;
/** `--format` / `--pretty`: `%G...` placeholders run gpg. */
const FORMAT = /^(?!.*%G)[A-Za-z0-9._/@^:=,+%-]{1,200}$/;
const words = (...v: string[]) => new RegExp(`^(?:${v.join("|")})$`);

const entries = (names: string[], o: Opt): [string, Opt][] => names.map((n) => [n, o]);

/** git status. Exact names: git's own abbreviations (`--out` for `--output`) are never reached. */
export const STATUS: Record<string, Opt> = Object.fromEntries([
  ...entries(["-s", "--short", "-b", "--branch", "--long", "-u", "-uno", "-unormal", "-uall", "--no-renames", "--ahead-behind", "--no-ahead-behind", "--show-stash", "-z"], FLAG),
  ["--porcelain", val(words("v1", "v2"), true)],
  ["--untracked-files", val(words("no", "normal", "all"), true)],
  ["--ignored", val(words("traditional", "matching", "no"), true)],
]);

/** diff, log, show. Not listed on purpose: --output, --ext-diff, --textconv, --no-index, --show-signature, -O, --stdin, --remerge-diff, --exec, -L, -G, -S. */
export const DIFF: Record<string, Opt> = Object.fromEntries([
  ...entries(
    ["-p", "-u", "--patch", "--no-patch", "-s", "--raw", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--compact-summary", "--no-color", "-w", "-b", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--full-index", "--relative", "--no-relative", "--check", "--minimal", "--patience", "--histogram", "-a", "--text", "--no-ext-diff", "--no-textconv", "-z", "--no-renames"],
    FLAG,
  ),
  ["--stat", val(/^\d{1,4}(,\d{1,4}){0,2}$/, true)],
  ["--color", val(words("never", "always", "auto"), true)],
  ["--word-diff", val(words("plain", "color", "porcelain", "none"), true)],
  ["--find-renames", val(/^\d{1,3}%?$/, true)],
  ["--diff-filter", val(/^[ACDMRTUXBacdmrtuxb]+$/)],
  ["--unified", val(N)],
  ["--abbrev", val(N, true)],
]);

export const LOG: Record<string, Opt> = Object.fromEntries([
  ...entries(
    ["--oneline", "--graph", "--no-decorate", "--abbrev-commit", "--no-abbrev-commit", "--all", "--branches", "--tags", "--remotes", "--no-merges", "--merges", "--first-parent", "--reverse", "--topo-order", "--date-order", "--follow", "--left-right", "--cherry-pick", "--boundary", "-i", "--regexp-ignore-case"],
    FLAG,
  ),
  ["--decorate", val(words("short", "full", "auto", "no"), true)],
  ["--max-count", val(N)],
  ["--skip", val(N)],
  ...["--since", "--until", "--after", "--before", "--author", "--committer", "--grep"].map((n): [string, Opt] => [n, val(FREE)]),
  ["--date", val(words("relative", "iso", "iso-strict", "rfc", "short", "local", "default", "raw", "unix", "human"))],
  ["--format", val(FORMAT)],
  ["--pretty", val(FORMAT)],
]);

const DIFF_ONLY: Record<string, Opt> = Object.fromEntries([...entries(["--cached", "--staged", "--merge-base"], FLAG)]);

/** Letters that may be bundled (`-sb`): flags without a value. */
const BUNDLE: Record<string, string> = { status: "sbz", diff: "pusbwaz", log: "pusbwaz", show: "pusbwaz" };

type Cmd = "status" | "log" | "show" | "diff";
const TABLES: Record<Cmd, Record<string, Opt>> = {
  status: STATUS,
  log: { ...DIFF, ...LOG },
  show: { ...DIFF, ...LOG },
  diff: { ...DIFF, ...DIFF_ONLY },
};

const MAX_COMMAND = 1000;
const MAX_SEGMENTS = 5;
/** No quotes, `$`, backtick, `\`, `* ? [ ]`, `# ! < > ( )`, tab, newline, NUL or non-ASCII: what is parsed here is what bash runs. */
const CHARSET = /^[A-Za-z0-9 ._/@^~:=,+%{}&|;-]+$/;
const GLOBAL_OPTS = new Set(["--no-pager", "--no-optional-locks"]);
const REV_PARSE = new Set(["HEAD", "--abbrev-ref", "--short", "--show-toplevel", "--is-inside-work-tree"]);

/** `-3`, `-n 5`, `-n5`, `-U3`, `-M50%`: options with an attached number. */
function numbered(tok: string, cmd: Cmd): boolean {
  if (cmd === "status") return false;
  if (/^-U\d{1,6}$/.test(tok)) return true;
  if (/^-M(\d{1,3}%?)?$/.test(tok)) return true;
  return cmd !== "diff" && (/^-\d{1,6}$/.test(tok) || /^-n\d{1,6}$/.test(tok));
}

/** Whether `tok` (before any `--`) is an allowed option. */
function optionOk(tok: string, cmd: Cmd): boolean {
  if (numbered(tok, cmd)) return true;
  const table = TABLES[cmd];
  const eq = tok.indexOf("=");
  const name = eq < 0 ? tok : tok.slice(0, eq);
  if (Object.hasOwn(table, name)) {
    const o = table[name];
    if (eq < 0) return !o || o.optional;
    return !!o && o.value.test(tok.slice(eq + 1));
  }
  // `-sb`: letters of value-less flags only; a lone long option never reaches here.
  return eq < 0 && /^-[A-Za-z]{2,}$/.test(tok) && [...tok.slice(1)].every((c) => BUNDLE[cmd]!.includes(c));
}

/**
 * A revision or a path: no leading `~` `:` `/` or drive, no `..` segment, `~` only after a name character, `{}` only as `@{name}`,
 * no denied name in its path part (after the first `:`), and a path that exists on disk passes the read path check.
 * `isPath`: after `--`, so the whole token is a path.
 */
function positionalOk(tok: string, cwd: string, isPath: boolean): boolean {
  if (!tok || /^[~:/\\]/.test(tok) || /^[A-Za-z]:/.test(tok)) return false;
  for (let i = 0; i < tok.length; i++) if (tok[i] === "~" && !(i > 0 && /[A-Za-z0-9_^}]/.test(tok[i - 1]!))) return false;
  // `@{u}`, `HEAD@{1}`, `@{-1}`; `{1..3}` would be a brace expansion.
  if (/[{}]/.test(tok.replace(/@\{(?!.*\.\.)[A-Za-z0-9.-]+\}/g, ""))) return false;
  const all = tok.split(/[/:]/);
  if (all.includes("..")) return false;
  const colon = isPath ? -1 : tok.indexOf(":");
  const head = colon < 0 ? (isPath ? "" : tok) : tok.slice(0, colon);
  const path = isPath ? tok : colon < 0 ? "" : tok.slice(colon + 1);
  // A bare token is a revision or a pathspec: names are denied (`.env`), its `~` is a revision's.
  if (head && deniedRead(head.split("/"), true)) return false;
  if (path && deniedRead(path.split("/"))) return false;
  for (const part of [head, path]) {
    if (part && lstatSync(resolve(cwd, part), { throwIfNoEntry: false }) && !pathLow(part, cwd, false)) return false;
  }
  return true;
}

function segmentOk(seg: string, cwd: string): boolean {
  const w = seg.trim().split(/ +/);
  if (w[0] !== "git") return false;
  let i = 1;
  while (w[i]?.startsWith("-")) {
    if (!GLOBAL_OPTS.has(w[i]!)) return false;
    i++;
  }
  const sub = w[i++];
  const rest = w.slice(i);
  if (sub === "branch") return rest.length === 1 && rest[0] === "--show-current";
  if (sub === "rev-parse") return rest.length > 0 && rest.every((a) => REV_PARSE.has(a));
  if (sub !== "status" && sub !== "log" && sub !== "show" && sub !== "diff") return false;
  let dashes = false;
  for (let k = 0; k < rest.length; k++) {
    const tok = rest[k]!;
    if (dashes) {
      if (!positionalOk(tok, cwd, true)) return false;
    } else if (tok === "--") dashes = true;
    else if (tok === "-n" && sub !== "status" && sub !== "diff") {
      if (!N.test(rest[++k] ?? "")) return false;
    } else if (tok.startsWith("-")) {
      if (!optionOk(tok, sub)) return false;
    } else if (!positionalOk(tok, cwd, false)) return false;
  }
  return true;
}

/** Whether the Bash tool input is a chain (`&&`, `||`, `;`) of read-only git commands to run in `cwd`, which holds a `.git`. */
export function gitReadOnly(input: unknown, cwd: string): boolean {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    const o = input as Record<string, unknown>;
    if (Object.keys(o).some((k) => k !== "command" && k !== "description" && k !== "timeout")) return false;
    const cmd = o.command;
    if (typeof cmd !== "string" || !cmd || cmd.length > MAX_COMMAND || !CHARSET.test(cmd)) return false;
    // Git finds the repository from the cwd upward: needs its own `.git`, so it never walks into a parent repository.
    if (!lstatSync(join(cwd, ".git"), { throwIfNoEntry: false })) return false;
    const segs = cmd.split(/\s*(?:&&|\|\||;)\s*/);
    if (segs.length > MAX_SEGMENTS) return false;
    return segs.every((s) => s.trim() !== "" && !/[&|]/.test(s) && segmentOk(s, cwd));
  } catch {
    return false;
  }
}
