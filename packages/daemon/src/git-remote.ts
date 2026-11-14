// Remote operations of the Graph tab (docs/spec.md "Layout", Graph tab; wire `git.fetch`, later `git.push`/`git.pull`):
// started by a click, so the repository's hooks run like in a terminal; they never prompt for credentials.
import { isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HARDEN, tagDeleteArgv, tagDeleteRemoteArgv, wslHostPath, wslPathOf } from "@claude-ui/protocol";
import type { GitBranchInfo, GitBranchResult } from "@claude-ui/protocol";
import { ceilingEnv, gitDirsOf, gitOperation, gitRefs, isHash, real, topIn, WorktreeError } from "./git.ts";
import { BATCH_SSH, runGit } from "./git-runner.ts";
import { redact } from "./plugins.ts";
import { foreignPointer } from "./remote-path.ts";

export const REMOTE_TIMEOUT = 120_000;
/** Test seam: the timeout of a remote operation. */
export const remoteConfig = { timeout: REMOTE_TIMEOUT };
const MAX_REMOTES = 20;
/** Fetch needs no fsmonitor program and no `ext::` transport; submodules stay as they are. */
/** `HARDEN` lives in the protocol package (the web app shows the commands that use it). */
export { HARDEN };
export const FETCH_ARGS = [...HARDEN, "fetch", "--all", "--no-recurse-submodules"];
/** Push, pull and fetch never follow submodules (their remotes are not checked against the roots) and push sends no tags the dialog does not show. */
const PUSH = [...HARDEN, "push", "--no-recurse-submodules", "--no-follow-tags"];
const MAX_OUTPUT = 8000;
export const MAX_ERROR = 4000;
const AUTH_FAILURE = /terminal prompts disabled|could not read (Username|Password)|Permission denied \(publickey|Host key verification failed|Authentication failed|BatchMode/i;
const AUTH_HINT = "The daemon cannot ask for credentials: set up a credential helper, ssh-agent or known_hosts in a terminal, then retry.";

const HOST = String.raw`[^\s@/:'"<>]+`;
// git prints userinfo without its scheme too (`unable to look up bob:pw@host:9`): `user:pass@` goes, keeping `user@` for an scp-like `user:pass@host:path`.
const PASSWORD_AT = new RegExp(String.raw`([^\s@/:'"<>]+):[^\s@]*@(?=(${HOST})(:[^\d\s])?)`, "g");
// `token@host` (host alone or with a port, no path after a colon): a token or user name. `git@github.com:o/r.git` is scp-like and stays.
const USER_AT = new RegExp(String.raw`(^|[\s'"(])[^\s@/:'"<>()]+@(?=${HOST}(?::\d+)?(?:$|[\s/'")]|[.,;](?:\s|$)))`, "g");
/** `redact()` (`scheme://userinfo@`) plus userinfo without a scheme. */
export function redactUrls(text: string): string {
  return redact(text)
    .replace(PASSWORD_AT, (_m, user: string, _h: string, scpPath: string | undefined) => (scpPath ? `${user}@` : ""))
    .replace(USER_AT, "$1");
}

/** Output for the client: each line keeps the text after its last `\r` (progress), userinfo of URLs removed, last `max` chars. */
export function tidy(text: string, max: number): string {
  const t = redactUrls(text.split("\n").map((l) => l.slice(l.lastIndexOf("\r") + 1)).join("\n")).trim();
  return t.length > max ? t.slice(t.length - max) : t;
}

/** Env of every git write: the repository pin, no prompt of any kind. */
export async function writeEnv(top: string): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, ...(await ceilingEnv(top)), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never" };
}

/** Env of every remote operation: `writeEnv` (credentials come from the user's helpers and ssh-agent only) and a BatchMode ssh. */
export async function remoteEnv(top: string, sshCommand: string): Promise<NodeJS.ProcessEnv> {
  // A WSL repository's git never sees the Windows ssh variables (`wslEnv`); only its own core.sshCommand counts.
  const ownSsh = (wslPathOf(top) ? "" : process.env.GIT_SSH_COMMAND || process.env.GIT_SSH) || sshCommand;
  return { ...(await writeEnv(top)), ...(!ownSsh && { GIT_SSH_COMMAND: BATCH_SSH }) };
}

/**
 * The local path a remote URL names, `""` for a `file://` URL that cannot be read (refused), undefined for a network URL.
 * Relative paths resolve against `top`; a POSIX path of a WSL repository against its `\\wsl$` host path.
 */
export function localRemotePath(url: string, top: string): string | undefined {
  let u = url.trim();
  if (/^file:\/\//i.test(u)) {
    try {
      return fileURLToPath(u);
    } catch {
      return "";
    }
  }
  if (/^file::/i.test(u)) u = u.slice(6);
  else if (/^[a-z][a-z0-9+.-]*::/i.test(u) || /^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return undefined;
  else if (/^[a-z]:[\\/]/i.test(u)) return u;
  else if (/^[^/\\]*:/.test(u)) return undefined;
  const w = wslPathOf(top);
  if (w && u.startsWith("/")) return wslHostPath(w.root, u);
  return isAbsolute(u) ? u : resolve(top, u);
}

/** One write operation (fetch, push, pull, commit) per repository (all its worktrees): a second one is refused, not queued. */
const running = new Set<string>();
export async function exclusive<T>(top: string, fn: () => Promise<T>): Promise<T> {
  const key = gitDirsOf(top)?.common ?? top;
  if (running.has(key)) throw new WorktreeError("busy", "Another git operation is running in this repository");
  running.add(key);
  try {
    return await fn();
  } finally {
    running.delete(key);
  }
}

type Failure = Error & { stderr?: string; stdout?: Buffer; killed?: boolean };
/** Plain git call of this module: not read-only (the user asked for a remote operation), no slot (a call may run for minutes). */
async function local(top: string, args: string[], env: NodeJS.ProcessEnv, timeout = 30_000): Promise<{ out: string; code: number }> {
  try {
    return { out: (await runGit({ cwd: top, args, env, timeout })).stdout.toString("utf8").trim(), code: 0 };
  } catch (e) {
    const err = e as Failure & { code?: number | string };
    if (err.killed) throw new WorktreeError("git_failed", `git ${args[0]} timed out`);
    if (err.code === 1) return { out: "", code: 1 };
    throw new WorktreeError("git_failed", tidy(err.stderr || err.message, MAX_ERROR));
  }
}

/** A remote whose URL is a local folder must be inside the roots: fetch would import objects from outside them, push would write there. */
async function checkRemotes(top: string, names: string[], push: boolean, env: NodeJS.ProcessEnv, allowed: (p: string) => boolean, platform: string): Promise<void> {
  for (const name of names) {
    if (!/^[^\0\s-][^\0\s]*$/.test(name)) throw new WorktreeError("bad_request", "Unsupported remote name");
    const { out } = await local(top, ["remote", "get-url", ...(push ? ["--push"] : []), "--all", name], env);
    for (const line of out.split("\n").filter(Boolean)) {
      const p = localRemotePath(line, top);
      // A UNC or device path (also as the raw value, or as `file://host/share`): refused on the string, before any file call (SMB lookup, NTLM).
      if (foreignPointer(line.trim(), top, platform) || (p !== undefined && foreignPointer(p, top, platform))) throw new WorktreeError("remote_not_allowed", `The remote ${name} is on another host or a device path`);
      if (p !== undefined && (p === "" || !allowed(real(p)))) throw new WorktreeError("remote_not_allowed", `The remote ${name} is a folder outside the allowed roots`);
    }
  }
}

/** Runs git with the remote timeout. Failure: git's text (redacted) plus a hint when it asked for credentials; success: its output. */
async function remoteOp(top: string, verb: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const r = await runGit({ cwd: top, args, env, timeout: remoteConfig.timeout, killTree: true });
    return tidy(`${r.stdout.toString("utf8")}\n${r.stderr}`, MAX_OUTPUT);
  } catch (e) {
    const err = e as Failure;
    if (err.killed || err.message === "git timed out") throw new WorktreeError("git_failed", `git ${verb} timed out after ${Math.round(remoteConfig.timeout / 1000)} s: the remote did not answer, or git waited for credentials`);
    const text = tidy(`${err.stdout?.toString("utf8") ?? ""}\n${err.stderr ?? ""}` || err.message, MAX_ERROR) || tidy(err.message, MAX_ERROR);
    throw new WorktreeError("git_failed", AUTH_FAILURE.test(text) ? `${text}\n${AUTH_HINT}` : text);
  }
}

export type RemoteResult = { output: string; refs: string | null };

/** Remote names and the user's own ssh command of the repository (`core.sshCommand`). */
export async function remoteConfigOf(top: string): Promise<{ names: Set<string>; sshCommand: string; defaultRemote?: string }> {
  const base = { ...process.env, ...(await ceilingEnv(top)), GIT_TERMINAL_PROMPT: "0" };
  const cfg = await local(top, ["config", "--get-regexp", "^(remote\\..+\\.url|core\\.sshcommand|branch\\.(main|master)\\.remote)$"], base);
  const names = new Set<string>();
  let sshCommand = "";
  const tracked: Record<string, string> = {};
  for (const line of cfg.out.split("\n").filter(Boolean)) {
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    if (key.toLowerCase() === "core.sshcommand") sshCommand = line.slice(sp + 1);
    else if (/^branch\.(main|master)\.remote$/i.test(key)) tracked[key.toLowerCase()] = line.slice(sp + 1);
    else names.add(key.slice(7, -4));
  }
  // The remote of the default branch: its tracking remote, else origin.
  const defaultRemote = tracked["branch.main.remote"] ?? tracked["branch.master.remote"] ?? (names.has("origin") ? "origin" : undefined);
  return { names, sshCommand, ...(defaultRemote && { defaultRemote }) };
}

export type RemoteOptions = { allowed: (p: string) => boolean; platform?: string };

/** `git fetch --all` in the repository of `cwd`; null outside a work tree. `defaultRemote`: `git fetch --prune <remote of the default branch>` only (Clean up). */
export async function gitFetch(cwd: string, o: RemoteOptions & { defaultRemote?: boolean }): Promise<RemoteResult | null> {
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  return exclusive(top, async () => {
    const { names, sshCommand, defaultRemote } = await remoteConfigOf(top);
    if (o.defaultRemote && (!defaultRemote || !/^[^\0\s-][^\0\s]*$/.test(defaultRemote) || !names.has(defaultRemote))) throw new WorktreeError("bad_request", "No remote for the default branch");
    if (names.size === 0) throw new WorktreeError("bad_request", "No remote to fetch from");
    if (names.size > MAX_REMOTES) throw new WorktreeError("bad_request", `Too many remotes (${names.size}): fetch in a terminal`);
    const env = await remoteEnv(top, sshCommand);
    await checkRemotes(top, o.defaultRemote ? [defaultRemote!] : [...names], false, env, o.allowed, o.platform ?? process.platform);
    const output = await remoteOp(top, "fetch", o.defaultRemote ? [...HARDEN, "fetch", "--prune", "--no-recurse-submodules", defaultRemote!] : FETCH_ARGS, env);
    return { output, refs: await gitRefs(top, o.allowed) };
  });
}

// ---- Branch menu: push, force push, pull (docs/spec.md "Layout", Graph tab) ----

const hex = (h: unknown): h is string => isHash(h);
/** Only local branches: a push or pull never acts on HEAD, a sha, a tag or a remote branch. */
export function branchRef(ref: unknown): string {
  const ok = typeof ref === "string" && ref.length <= 255 && /^refs\/heads\/[^\0-\x20\x7f~^:?*[\\]+$/.test(ref) && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith("/") && !ref.endsWith(".lock") && !ref.endsWith(".") && !ref.includes("//");
  if (!ok) throw new WorktreeError("bad_request", "Not a local branch");
  return ref;
}

const RS = "\x1e";
const US = "\x1f";
const sameDir = (a: string, b: string) => real(a) === real(b);

/** "here", the other work tree's path in the platform's form, or undefined; a WSL repository's git prints POSIX paths. */
export function checkedOutOf(worktree: string, top: string): string | undefined {
  if (!worktree) return undefined;
  const w = wslPathOf(top);
  const p = w && worktree.startsWith("/") ? wslHostPath(w.root, worktree) : worktree;
  return sameDir(p, top) ? "here" : normalize(p);
}

/** Everything the menu shows and the exact argv of each action, re-read from git. */
export async function branchInfo(top: string, ref: string, env: NodeJS.ProcessEnv, remotes: Set<string>): Promise<GitBranchInfo> {
  const f = (...fields: string[]) => `--format=${fields.join(`%1f`)}%1e`;
  const rows = (out: string) => out.split(RS).map((r) => r.replace(/^\n/, "")).filter(Boolean).map((r) => r.split(US));
  const own = rows((await local(top, ["for-each-ref", f("%(refname)", "%(objectname)", "%(upstream)", "%(upstream:remotename)", "%(upstream:remoteref)", "%(push:remotename)", "%(worktreepath)"), "--", ref], env)).out).find((r) => r[0] === ref);
  if (!own) throw new WorktreeError("bad_request", "Unknown branch");
  const [, localHash = "", upstream = "", upRemote = "", upRef = "", pushRemote = "", worktree = ""] = own;
  const remoteRefs = new Map<string, string>();
  const symrefs = new Map<string, string>();
  for (const r of rows((await local(top, ["for-each-ref", f("%(refname)", "%(objectname)", "%(symref)"), "--", "refs/remotes"], env)).out)) {
    remoteRefs.set(r[0]!, r[1]!);
    if (r[2]) symrefs.set(r[0]!, r[2]);
  }
  const info: GitBranchInfo = { ref, local: localHash };
  // git prints `C:/x/y` on Windows: shown in the platform's own form, like every other path.
  const co = checkedOutOf(worktree, top);
  if (co) info.checkedOut = co;
  if (upstream) info.upstream = upstream.replace(/^refs\/(heads|remotes)\//, "");
  if (upstream.startsWith("refs/remotes/") && remoteRefs.has(upstream)) info.upstreamHash = remoteRefs.get(upstream);
  const only = remotes.size === 1 ? [...remotes][0] : undefined;
  const remote = [pushRemote, upRemote !== "." ? upRemote : "", only, remotes.has("origin") ? "origin" : undefined].find((r) => r && remotes.has(r));
  const why: NonNullable<GitBranchInfo["why"]> = {};
  if (!remote) {
    why.push = "No remote";
    why.forcePush = "No remote";
  } else {
    const remoteRef = upRemote === remote && upRef ? upRef : ref;
    const tracking = `refs/remotes/${remote}/${remoteRef.replace(/^refs\/heads\//, "")}`;
    info.remote = remote;
    info.remoteRef = remoteRef;
    const trackingHash = remoteRefs.get(tracking);
    if (trackingHash) {
      info.tracking = tracking;
      info.trackingHash = trackingHash;
      info.isDefault = symrefs.get(`refs/remotes/${remote}/HEAD`) === tracking;
      const lr = await local(top, ["rev-list", "--left-right", "--count", `${ref}...${tracking}`], env);
      const [a, b] = lr.out.split(/\s+/).map(Number);
      if (Number.isInteger(a) && Number.isInteger(b)) {
        info.ahead = a;
        info.behind = b;
      }
    }
    const spec = `${ref}:${remoteRef}`;
    info.push = [...PUSH, ...(upstream ? [] : ["--set-upstream"]), remote, spec];
    if (trackingHash) info.forcePush = [...PUSH, `--force-with-lease=${remoteRef}:${trackingHash}`, remote, spec];
    else why.forcePush = `No ${remote}/${remoteRef.replace(/^refs\/heads\//, "")} yet: fetch first`;
  }
  if (!upstream) why.pull = "No upstream branch";
  else if (upRemote === "." || !upRemote || !upRef) why.pull = "The upstream is a local branch: pull in a terminal";
  else if (info.checkedOut === "here") info.pull = [...HARDEN, "pull", "--no-recurse-submodules", "--no-rebase", "--ff-only", upRemote, upRef];
  else if (info.checkedOut) why.pull = `Checked out in ${info.checkedOut}: pull there`;
  else info.pull = [...HARDEN, "fetch", "--no-recurse-submodules", upRemote, `${upRef}:${ref}`];
  // Merge and rebase act on HEAD: what the menu showed of it (`headRef`, `headHash`) is checked again before the run.
  const head = (await local(top, ["rev-parse", "--verify", "-q", "HEAD"], env)).out;
  const headRef = (await local(top, ["symbolic-ref", "-q", "HEAD"], env)).out;
  if (headRef) info.headRef = headRef;
  if (head) info.headHash = head;
  const op = await gitOperation(top);
  const blocked = !headRef ? "HEAD is detached" : !head ? "No commits yet" : headRef === ref ? "This is the current branch" : op ? (op.conflicted.length ? "Resolve the conflicts first" : `Finish or abort the ${op.kind} first`) : undefined;
  if (blocked) {
    why.merge = blocked;
    why.rebase = blocked;
  } else {
    // The short name gives the message "Merge branch 'x'" (the full ref would print `refs/heads/x`); when git reads it as something else (a tag), the full ref.
    const short = ref.slice(11);
    const same = (await local(top, ["rev-parse", "--verify", "-q", `${short}^{commit}`], env)).out === info.local;
    info.merge = [...HARDEN, "merge", "--no-edit", same ? short : ref];
    info.rebase = [...HARDEN, "rebase", ref];
  }
  if (Object.keys(why).length) info.why = why;
  return info;
}

/** Menu data of a local branch; null outside a work tree. */
export async function gitBranch(cwd: string, ref: string, o: RemoteOptions): Promise<GitBranchResult["branch"]> {
  const r = branchRef(ref);
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  const { names } = await remoteConfigOf(top);
  return branchInfo(top, r, { ...process.env, ...(await ceilingEnv(top)), GIT_TERMINAL_PROMPT: "0" }, names);
}

/** `argv`: the command the dialog showed; the daemon runs only what it computes again to the same words. */
type Write = { ref: string; local: string; argv: string[]; lease?: string; tracking?: string } & RemoteOptions;
async function writeOp(cwd: string, o: Write, verb: "push" | "pull"): Promise<RemoteResult | null> {
  const ref = branchRef(o.ref);
  if (!hex(o.local)) throw new WorktreeError("bad_request", "Bad commit");
  if (o.lease !== undefined && !hex(o.lease)) throw new WorktreeError("bad_request", "Bad lease");
  if (o.tracking !== undefined && !hex(o.tracking)) throw new WorktreeError("bad_request", "Bad tracking");
  if (!Array.isArray(o.argv) || o.argv.length > 64 || !o.argv.every((a) => typeof a === "string")) throw new WorktreeError("bad_request", "Missing command");
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  return exclusive(top, async () => {
    const { names, sshCommand } = await remoteConfigOf(top);
    const env = await remoteEnv(top, sshCommand);
    const info = await branchInfo(top, ref, env, names);
    const x = ref.slice(11);
    if (o.local !== info.local) throw new WorktreeError("stale", `${x} moved since the menu opened: reopen it`);
    const shown = verb === "push" ? info.trackingHash : info.upstreamHash;
    const shownRef = verb === "push" ? info.tracking?.replace(/^refs\/remotes\//, "") : info.upstream;
    // No `tracking` while one exists: a page from an older build, which reopening the menu cannot fix.
    if (o.tracking === undefined && shown) throw new WorktreeError("stale", "This page is out of date: reload it, then retry");
    if (o.tracking !== shown) throw new WorktreeError("stale", `${shownRef ?? "The remote branch"} moved since the menu opened: reopen it`);
    let argv: string[];
    let remote: string | undefined;
    if (verb === "push") {
      remote = info.remote;
      if (o.lease !== undefined) {
        if (!info.forcePush) throw new WorktreeError("bad_request", info.why?.forcePush ?? "Force push is not available");
        if (o.lease !== info.trackingHash) throw new WorktreeError("stale", `${info.tracking!.replace(/^refs\/remotes\//, "")} moved since the menu opened: fetch and reopen it`);
        argv = info.forcePush;
      } else {
        if (!info.push) throw new WorktreeError("bad_request", info.why?.push ?? "Push is not available");
        argv = info.push;
      }
    } else {
      if (!info.pull) throw new WorktreeError("bad_request", info.why?.pull ?? "Pull is not available");
      argv = info.pull;
      // Both variants end with `<remote> <ref>`.
      remote = argv.at(-2);
    }
    if (o.argv.length !== argv.length || o.argv.some((a, i) => a !== argv[i])) throw new WorktreeError("stale", "The command changed since the menu opened");
    await checkRemotes(top, remote ? [remote] : [], verb === "push", env, o.allowed, o.platform ?? process.platform);
    const output = await remoteOp(top, verb, argv, env).catch((e: unknown) => {
      // The lease failed on the remote: say it plainly instead of git's "(stale info)".
      if (o.lease !== undefined && e instanceof WorktreeError && /stale info/.test(e.message)) throw new WorktreeError("stale", "The remote branch changed since the menu opened; fetch and retry");
      throw e;
    });
    return { output, refs: await gitRefs(top, o.allowed) };
  });
}
export const gitPush = (cwd: string, o: Write) => writeOp(cwd, o, "push");
export const gitPull = (cwd: string, o: Omit<Write, "lease">) => writeOp(cwd, o, "pull");

// ---- Tags: Remove Tag on remotes (docs/spec.md "Layout", Graph tab; wire `git.tagRemote`, `git.tagDelete`) ----

const MAX_TAG_NAME = 255;
/** A tag name git accepts as `refs/tags/<name>`, else `bad_request`. */
export async function checkTagName(top: string, name: unknown, env: NodeJS.ProcessEnv): Promise<string> {
  const bad = () => new WorktreeError("bad_request", "Not a valid tag name");
  if (typeof name !== "string" || !name || name.length > MAX_TAG_NAME || name.startsWith("-") || name.includes("\0")) throw bad();
  if ((await local(top, ["check-ref-format", `refs/tags/${name}`], env)).code !== 0) throw bad();
  return name;
}

/** The value of local `refs/tags/<name>` (the tag object of an annotated tag), "" when there is none. */
export async function localTagHash(top: string, name: string, env: NodeJS.ProcessEnv): Promise<string> {
  return (await local(top, ["rev-parse", "-q", "--verify", `refs/tags/${name}`], env)).out;
}

/** Whether `remote` has the tag (`git ls-remote`): `hash` absent = it has not. Null outside a work tree. */
export async function gitTagRemote(cwd: string, o: { name: unknown; remote: unknown } & RemoteOptions): Promise<{ remote: string; hash?: string } | null> {
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  const { names, sshCommand } = await remoteConfigOf(top);
  const remote = o.remote;
  if (typeof remote !== "string" || !names.has(remote)) throw new WorktreeError("bad_request", "Unknown remote");
  const env = await remoteEnv(top, sshCommand);
  const name = await checkTagName(top, o.name, env);
  await checkRemotes(top, [remote], false, env, o.allowed, o.platform ?? process.platform);
  const out = await remoteOp(top, "ls-remote", [...HARDEN, "ls-remote", "--refs", remote, `refs/tags/${name}`], env);
  const row = out.split("\n").map((l) => l.trim().split(/\s+/)).find((r) => r[1] === `refs/tags/${name}` && isHash(r[0]));
  return row ? { remote, hash: row[0]! } : { remote };
}

type TagRemoteDelete = { remote: unknown; hash: unknown; argv: unknown };
const sameArgv = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Deletes tag `name` on each of `remotes` (lease on the hash the dialog showed), in order, then locally (`tag -d`).
 * `hash`: local `refs/tags/<name>` as shown. A remote failure stops before the local delete. Null outside a work tree.
 */
export async function gitTagDelete(cwd: string, o: { name: unknown; hash: unknown; argv: unknown; remotes?: unknown } & RemoteOptions): Promise<RemoteResult | null> {
  const bad = (m: string) => new WorktreeError("bad_request", m);
  const remotes = o.remotes === undefined ? [] : o.remotes;
  if (!isHash(o.hash)) throw bad("hash must be the tag's hash");
  if (!Array.isArray(remotes) || remotes.length > MAX_REMOTES) throw bad("remotes must be a list of at most 20 remotes");
  const top = await topIn(cwd, o.allowed);
  if (!top) return null;
  return exclusive(top, async () => {
    const { names, sshCommand } = await remoteConfigOf(top);
    const env = await remoteEnv(top, sshCommand);
    const name = await checkTagName(top, o.name, env);
    const hash = o.hash as string;
    if ((await localTagHash(top, name, env)) !== hash) throw new WorktreeError("stale", `Tag ${name} moved since the dialog opened: reopen it`);
    const stale = () => new WorktreeError("stale", "The command changed since the dialog opened");
    if (!sameArgv(o.argv, tagDeleteArgv(name))) throw stale();
    const seen = new Set<string>();
    const plan = (remotes as TagRemoteDelete[]).map((r) => {
      if (!r || typeof r.remote !== "string" || !names.has(r.remote) || seen.has(r.remote)) throw bad("Unknown remote");
      if (!isHash(r.hash)) throw bad("hash must be the remote tag's hash");
      seen.add(r.remote);
      if (!sameArgv(r.argv, tagDeleteRemoteArgv(r.remote, name, r.hash))) throw stale();
      return { remote: r.remote, argv: r.argv as string[] };
    });
    await checkRemotes(top, plan.map((r) => r.remote), true, env, o.allowed, o.platform ?? process.platform);
    const outputs: string[] = [];
    const done: string[] = [];
    for (const r of plan) {
      try {
        outputs.push(await remoteOp(top, "push", r.argv, env));
        done.push(r.remote);
      } catch (e) {
        const text = (e as Error).message;
        const was = done.length ? `\nAlready deleted on: ${done.join(", ")}` : "";
        if (/stale info/.test(text)) throw new WorktreeError("stale", `${r.remote} changed the tag since the dialog opened; reopen it${was}`);
        throw new WorktreeError(e instanceof WorktreeError ? e.code : "git_failed", `${text}${was}`);
      }
    }
    outputs.push(await remoteOp(top, "tag", [...HARDEN, ...tagDeleteArgv(name)], env));
    return { output: outputs.filter(Boolean).join("\n"), refs: await gitRefs(top, o.allowed) };
  });
}
