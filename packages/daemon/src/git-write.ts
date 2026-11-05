// Git writes of the Changes tab (docs/spec.md "Layout", Changes tab; wire `git.commitFiles`): started by a click, so the
// repository's hooks run like in a terminal; they never prompt. Later Git ops (rollback, checkout) extend this module.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { wslHostPath, wslPathOf } from "@claude-ui/protocol";
import type { GitCommitted, GitRollbackFile, GitRollbackPreview } from "@claude-ui/protocol";
import { openChecked, OPEN_READ, readAll, sameFile } from "./fd-check.ts";
import { gitRefs, pinScope, repoPath, topIn, WorktreeError } from "./git.ts";
import { exclusive, gitBranch, HARDEN, MAX_ERROR, tidy, writeEnv, type RemoteOptions } from "./git-remote.ts";
import { runGit } from "./git-runner.ts";

/** Test seam: the timeout of a write (hooks may run tests). */
export const writeConfig = { timeout: 300_000 };
const MAX_PATHS = 10_000;
const MAX_MESSAGE = 65_536;
const MAX_OUTPUT = 8000;

type Failure = Error & { stderr?: string; stdout?: Buffer; killed?: boolean; code?: number | string };
type Run = { out: string; code: number };
/** One git call of a write. `soft`: exit code 1 is an answer, not a failure. Failure text: stdout and stderr (hooks print on either). */
async function run(top: string, args: string[], env: NodeJS.ProcessEnv, o: { input?: string; soft?: boolean } = {}): Promise<Run> {
  try {
    const r = await runGit({ cwd: top, args: [...HARDEN, ...args], env, input: o.input, timeout: writeConfig.timeout, killTree: true });
    return { out: tidy(`${r.stdout.toString("utf8")}\n${r.stderr}`, MAX_OUTPUT), code: 0 };
  } catch (e) {
    const err = e as Failure;
    if (err.killed) throw new WorktreeError("git_failed", `git ${args.find((a) => !a.startsWith("-"))} timed out after ${Math.round(writeConfig.timeout / 1000)} s`);
    if (o.soft && err.code === 1) return { out: "", code: 1 };
    const text = tidy(`${err.stdout?.toString("utf8") ?? ""}\n${err.stderr ?? ""}`, MAX_ERROR) || tidy(err.message, MAX_ERROR);
    throw new WorktreeError("git_failed", text);
  }
}
const bad = (m: string) => new WorktreeError("bad_request", m);
const ask = async (top: string, args: string[], env: NodeJS.ProcessEnv) => (await run(top, args, env, { soft: true }));

/** The daemon's view of a path git printed (a WSL repository's git prints POSIX). */
function hostOf(top: string, gitPath: string): string {
  const w = wslPathOf(top);
  return w ? wslHostPath(w.root, gitPath) : resolve(top, gitPath);
}

const LITERAL = ["--literal-pathspecs"];
const FROM_STDIN = ["--pathspec-from-file=-", "--pathspec-file-nul"];

/**
 * Commits exactly `paths` (relative to the repository top; a rename names both sides) with their working-tree content, like
 * `git commit --only -- <paths>` but also for untracked files: a temporary index starts from HEAD, takes the paths, and
 * is committed; other entries of the real index and the work tree stay. `amend` rewrites HEAD (no path: its message only).
 * Needs git 2.26 (`--pathspec-from-file`). `push`: also returns the push dialog data of HEAD's branch. Null outside a work tree.
 */
export async function gitCommitFiles(cwd: string, o: { paths: unknown; message: unknown; amend?: unknown; push?: unknown } & RemoteOptions): Promise<GitCommitted | null> {
  const { paths, message } = o;
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) throw bad("paths must be a list of at most 10000 paths");
  const files = paths.map(repoPath);
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE || message.includes("\0")) throw bad("message must be non-empty text");
  if ((o.amend !== undefined && typeof o.amend !== "boolean") || (o.push !== undefined && typeof o.push !== "boolean")) throw bad("amend and push must be booleans");
  const amend = o.amend === true;
  if (!files.length && !amend) throw bad("No file to commit");
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    let branchRef: string | undefined;
    const committed = await exclusive(top, async () => {
      const head = await ask(top, ["rev-parse", "--verify", "-q", "HEAD"], env);
      if (amend && head.code === 1) throw bad("No commit to amend");
      // The temporary index starts from HEAD: it has no conflict entries, and the final `reset` would clear the real index's
      // ones; a merge commit would lose its second parent. Committing inside these states is the conflict banner's job.
      if ((await run(top, ["ls-files", "-u", "-z"], env)).out) throw bad("Resolve the conflicts first");
      for (const [state, op] of [["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]]) {
        if ((await ask(top, ["rev-parse", "--verify", "-q", state], env)).code === 0) throw bad(`Finish or abort the ${op} first`);
      }
      const [merge, apply] = (await run(top, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"], env)).out.split("\n");
      if (existsSync(hostOf(top, merge))) throw bad("Finish or abort the rebase first");
      if (existsSync(hostOf(top, apply))) throw bad(`Finish or abort the ${existsSync(hostOf(top, `${apply}/applying`)) ? "am" : "rebase"} first`);
      if (o.push) {
        const sym = await ask(top, ["symbolic-ref", "-q", "HEAD"], env);
        if (sym.code === 1) throw bad("HEAD is detached: use Commit");
        branchRef = sym.out;
      }
      const name = `claude-ui-commit-${randomUUID()}.index`;
      // git's own view of the path for GIT_INDEX_FILE; the daemon's view for the clean-up.
      const gitPath = (await run(top, ["rev-parse", "--git-path", name], env)).out;
      const hostPath = hostOf(top, gitPath);
      const tmp = { ...env, GIT_INDEX_FILE: gitPath };
      let out: string;
      try {
        await run(top, head.code === 1 ? ["read-tree", "--empty"] : ["read-tree", "HEAD"], tmp);
        if (files.length) await run(top, [...LITERAL, "add", "-A", ...FROM_STDIN], tmp, { input: files.join("\0") });
        out = (await run(top, ["commit", "-F", "-", ...(amend ? ["--amend"] : [])], tmp, { input: message })).out;
      } finally {
        await rm(hostPath, { force: true }).catch(() => {});
        await rm(`${hostPath}.lock`, { force: true }).catch(() => {});
      }
      // The commit is made: the real index takes HEAD's entries of the committed paths; a failure keeps the commit and says so.
      if (files.length) {
        try {
          await run(top, [...LITERAL, "reset", "-q", ...FROM_STDIN], env, { input: files.join("\0") });
        } catch (e) {
          out += `\nThe index of the committed files was not updated: ${(e as Error).message}`;
        }
      }
      return { hash: (await run(top, ["rev-parse", "HEAD"], env)).out, output: tidy(out, MAX_OUTPUT), refs: await gitRefs(top, o.allowed) };
    });
    return branchRef ? { ...committed, push: (await gitBranch(top, branchRef, o)) ?? undefined } : committed;
  });
}

const MAX_HUNK_LINES = 100_000;
const NO_EOL = "\\ No newline at end of file";
type WireHunk = { newStart: number; lines: string[] };
const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+/g) ?? [];
const bare = (l: string) => l.replace(/\r?\n$/, "");
const eolOf = (l: string) => /\r?\n$/.exec(l)?.[0] ?? "";

/**
 * `text` with one hunk of a unified diff undone (the hunk's `+` lines replaced by its `-` lines), or undefined when the lines
 * at `newStart` are not the hunk's new side (the file changed since the diff). `lines`: unified-diff lines without newline,
 * `\ No newline at end of file` after the last line of a side. `newStart`: unified convention (1-based; a pure deletion,
 * which has no new line, names the line before it). Line ends: the restored lines take the first end of the replaced region.
 * shortcut: one end style per hunk, a file with mixed LF and CRLF inside one hunk is normalised there, when it matters per-line.
 */
export function revertHunk(text: string, hunk: WireHunk): string | undefined {
  const file = splitLines(text);
  const now: { t: string; noEol: boolean }[] = [];
  const was: { t: string; noEol: boolean }[] = [];
  let last: "both" | "-" | "+" = "both";
  for (const l of hunk.lines) {
    if (l === NO_EOL) {
      for (const side of last === "both" ? [now, was] : last === "+" ? [now] : [was]) if (side.length) side[side.length - 1]!.noEol = true;
      continue;
    }
    const t = l.slice(1);
    last = l[0] === " " ? "both" : (l[0] as "-" | "+");
    if (l[0] !== "-") now.push({ t, noEol: false });
    if (l[0] !== "+") was.push({ t, noEol: false });
  }
  const start = now.length ? hunk.newStart - 1 : hunk.newStart;
  if (start < 0 || start + now.length > file.length) return undefined;
  const region = file.slice(start, start + now.length);
  if (!now.every((n, i) => bare(region[i]!) === n.t && (eolOf(region[i]!) === "") === n.noEol)) return undefined;
  const eol = region.map(eolOf).find(Boolean) ?? file.map(eolOf).find(Boolean) ?? "\n";
  // A context line keeps the file's own line; a removed line gets the region's end, none when the old side has no final newline.
  let ctx = 0;
  const restored: string[] = [];
  let k = 0;
  for (const l of hunk.lines) {
    if (l === NO_EOL || l[0] === "+") {
      if (l[0] === "+") ctx++;
      continue;
    }
    const w = was[k++]!;
    restored.push(l[0] === " " ? region[ctx++]! : w.t + (w.noEol ? "" : eol));
  }
  return [...file.slice(0, start), ...restored, ...file.slice(start + now.length)].join("");
}

type Entry = { path: string; kind: GitRollbackFile["kind"]; oldPath?: string; unmerged: boolean; untracked: boolean };
/** The porcelain v2 records of the repository, those naming one of `files` (either side of a rename), as file entries. */
function entriesOf(status: string, files: Set<string>): { entries: Entry[]; records: string[] } {
  const entries: Entry[] = [];
  const records: string[] = [];
  const parts = status.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const r = parts[i]!;
    const tag = r[0];
    if (tag === "?") {
      const path = r.slice(2);
      if (!files.has(path)) continue;
      records.push(r);
      // One row per path: an index delete with an untracked copy of the same path stays the tracked entry.
      if (!entries.some((e) => e.path === path)) entries.push({ path, kind: "A", unmerged: false, untracked: true });
    } else if (tag === "1" || tag === "u" || tag === "2") {
      const f = r.split(" ");
      const path = f.slice(tag === "1" ? 8 : tag === "2" ? 9 : 10).join(" ");
      const oldPath = tag === "2" ? parts[++i] : undefined;
      if (!files.has(path) && !(oldPath !== undefined && files.has(oldPath))) continue;
      const [x, y] = [f[1]![0]!, f[1]![1]!];
      const kind = tag === "2" ? "R" : x === "A" ? "A" : x === "D" || y === "D" ? "D" : "M";
      entries.push({ path, kind, ...(oldPath !== undefined && { oldPath }), unmerged: tag === "u", untracked: false });
      records.push(oldPath === undefined ? r : `${r}\0${oldPath}`);
    }
  }
  return { entries, records };
}

type Common = { allowed: RemoteOptions["allowed"]; /** Local history entry of a file about to change (GH-565). */ snapshot: (hostPath: string) => void };
/** The validated repository-relative paths of a rollback. */
function fileSet(paths: unknown): Set<string> {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS) throw bad("paths must be a list of 1 to 10000 paths");
  return new Set(paths.map(repoPath));
}
/** The classification and the token of `paths` (inside the lock for a rollback). */
async function classify(top: string, env: NodeJS.ProcessEnv, paths: unknown): Promise<{ entries: Entry[]; token: string }> {
  const files = fileSet(paths);
  if ((await ask(top, ["rev-parse", "--verify", "-q", "HEAD"], env)).code === 1) throw bad("No commit to roll back to");
  const head = (await run(top, ["rev-parse", "HEAD"], env)).out;
  const status = (await run(top, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], env)).out;
  const { entries, records } = entriesOf(status, files);
  if (entries.some((e) => e.unmerged)) throw bad("Resolve the conflict first");
  const h = createHash("sha256").update(head).update("\0").update(records.join("\0"));
  for (const e of entries) for (const p of [e.path, e.oldPath]) {
    if (p === undefined) continue;
    try {
      const st = lstatSync(hostOf(top, p));
      h.update(`\0${p}:${st.size}:${st.mtimeMs}`);
    } catch { /* absent */ }
  }
  return { entries, token: h.digest("hex") };
}

/** What a rollback of `paths` would do: the files git status lists for them, and the token a rollback must present. Null outside a work tree. */
export async function gitRollbackPreview(cwd: string, o: { paths: unknown } & Common): Promise<GitRollbackPreview | null> {
  fileSet(o.paths);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const { entries, token } = await classify(top, await writeEnv(top), o.paths);
    return { files: entries.map(({ path, kind, oldPath }) => ({ path, kind, ...(oldPath !== undefined && { oldPath }) })), token };
  });
}

/**
 * Rolls `paths` back to HEAD (work tree and index), like IntelliJ's Rollback; `token` is the preview's, a different state is
 * `stale`. Added files stay as untracked files unless `deleteAdded`; a rename's target is always removed. Every file that
 * changes or goes gets a local history entry first. Null outside a work tree.
 */
export async function gitRollback(cwd: string, o: { paths: unknown; token: unknown; deleteAdded?: unknown } & Common): Promise<{ output: string } | null> {
  if (typeof o.token !== "string") throw bad("token must be text");
  if (o.deleteAdded !== undefined && typeof o.deleteAdded !== "boolean") throw bad("deleteAdded must be a boolean");
  fileSet(o.paths);
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    return exclusive(top, async () => {
      const { entries, token } = await classify(top, env, o.paths);
      if (token !== o.token) throw new WorktreeError("stale", "The files changed since the dialog opened: reopen it");
      const drop = o.deleteAdded === true;
      const restore: string[] = []; // known to git: HEAD's version, or removed when HEAD has none
      const unstage: string[] = [];
      const track: string[] = []; // untracked files to delete: git must know them first
      const changing: string[] = [];
      for (const e of entries) {
        if (e.kind === "A" && !drop) {
          if (!e.untracked) unstage.push(e.path);
          continue;
        }
        (e.untracked ? track : restore).push(e.path);
        changing.push(e.path);
        if (e.oldPath !== undefined) (restore.push(e.oldPath), changing.push(e.oldPath));
      }
      for (const p of changing) {
        const host = hostOf(top, p);
        if (existsSync(host) && lstatSync(host).isFile()) o.snapshot(host);
      }
      const batch = async (cmd: string[], list: string[]) => list.length ? (await run(top, [...LITERAL, ...cmd, ...FROM_STDIN], env, { input: list.join("\0") })).out : "";
      const out = [
        await batch(["add", "-A"], track),
        await batch(["restore", "--source=HEAD", "--staged", "--worktree"], [...restore, ...track]),
        await batch(["restore", "--source=HEAD", "--staged"], unstage),
      ];
      return { output: tidy(out.filter(Boolean).join("\n"), MAX_OUTPUT) };
    });
  });
}

/** Undoes one hunk of the diff of `path` in the work tree only (the index stays): see `revertHunk`. `stale` when the lines no longer match. */
export async function gitRollbackHunk(cwd: string, o: { path: unknown; hunk: unknown; maxBytes: number } & Common): Promise<{ output: string } | null> {
  const path = repoPath(o.path);
  const h = o.hunk as WireHunk | null;
  if (!h || typeof h !== "object" || !Number.isInteger(h.newStart) || h.newStart < 0 || !Array.isArray(h.lines) || !h.lines.length || h.lines.length > MAX_HUNK_LINES
    || h.lines.some((l) => typeof l !== "string" || (l !== NO_EOL && !/^[ +-]/.test(l)) || /[\n\0]/.test(l)) || !h.lines.some((l) => l[0] === "-" || l[0] === "+")) throw bad("hunk must be a start and unified diff lines with a change");
  return pinScope(async () => {
    const top = await topIn(cwd, o.allowed);
    if (!top) return null;
    const env = await writeEnv(top);
    return exclusive(top, async () => {
      if ((await run(top, [...LITERAL, "ls-files", "-u", "-z", "--", path], env)).out) throw bad("Resolve the conflict first");
      const file = hostOf(top, path);
      if (!o.allowed(file)) throw new WorktreeError("cwd_not_allowed", `outside the allowlisted roots: ${path}`);
      let fd: number | undefined;
      try {
        fd = openChecked(file, OPEN_READ);
        const st = fstatSync(fd);
        if (!st.isFile()) throw bad(`not a file: ${path}`);
        if (st.size > o.maxBytes) throw bad(`larger than ${o.maxBytes} bytes: ${path}`);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(readAll(fd, st.size));
        } catch {
          throw bad(`not UTF-8 text: ${path}`);
        }
        const bom = text.startsWith("\uFEFF");
        const next = revertHunk(bom ? text.slice(1) : text, h);
        if (next === undefined) throw new WorktreeError("stale", "The file changed since the diff was shown");
        o.snapshot(file);
        // Atomic: a temp file beside the target (same mode), renamed over it; any error leaves the original. A path swapped for a link meanwhile is replaced, never followed.
        const tmp = `${file}.claude-ui-${randomUUID()}.tmp`;
        try {
          writeFileSync(tmp, bom ? `\uFEFF${next}` : next, { flag: "wx", mode: st.mode & 0o7777 });
          chmodSync(tmp, st.mode & 0o7777);
          if (!sameFile(fd, file)) throw Object.assign(new Error("changed during the request"), { code: "ECHANGED" });
          renameSync(tmp, file);
        } catch (e) {
          rmSync(tmp, { force: true });
          throw e;
        }
      } catch (e) {
        if (e instanceof WorktreeError) throw e;
        throw new WorktreeError("git_failed", (e as { code?: string }).code === "ECHANGED" ? `changed during the request: ${path}` : String(e));
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
      return { output: "" };
    });
  });
}
