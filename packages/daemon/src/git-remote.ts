// Remote operations of the Graph tab (docs/spec.md "Layout", Graph tab; wire `git.fetch`, later `git.push`/`git.pull`):
// started by a click, so the repository's hooks run like in a terminal; they never prompt for credentials.
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wslHostPath, wslPathOf } from "@claude-ui/protocol";
import { ceilingEnv, gitDirsOf, gitRefs, real, topIn, WorktreeError } from "./git.ts";
import { BATCH_SSH, runGit } from "./git-runner.ts";
import { redact } from "./plugins.ts";
import { foreignPointer } from "./remote-path.ts";

export const REMOTE_TIMEOUT = 120_000;
/** Test seam: the timeout of a remote operation. */
export const remoteConfig = { timeout: REMOTE_TIMEOUT };
const MAX_REMOTES = 20;
/** Fetch needs no fsmonitor program and no `ext::` transport; submodules stay as they are. */
export const FETCH_ARGS = ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never", "fetch", "--all", "--no-recurse-submodules"];
const MAX_OUTPUT = 8000;
const MAX_ERROR = 4000;
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

/** Env of every remote operation: no prompt of any kind (credentials come from the user's helpers and ssh-agent only). */
export function remoteEnv(top: string, sshCommand: string): NodeJS.ProcessEnv {
  const ownSsh = process.env.GIT_SSH_COMMAND || process.env.GIT_SSH || sshCommand;
  return { ...process.env, ...ceilingEnv(top), GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never", ...(!ownSsh && { GIT_SSH_COMMAND: BATCH_SSH }) };
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

/** One remote operation per repository (all its worktrees): a second one is refused, not queued. */
const running = new Set<string>();
async function exclusive<T>(top: string, fn: () => Promise<T>): Promise<T> {
  const key = gitDirsOf(top)?.common ?? top;
  if (running.has(key)) throw new WorktreeError("busy", "A fetch, push or pull is already running in this repository");
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

/** `git fetch --all` in the repository of `cwd`; null outside a work tree. */
export async function gitFetch(cwd: string, o: { allowed: (p: string) => boolean; platform?: string }): Promise<RemoteResult | null> {
  // The WSL runners (side, wsl.exe) cannot end a timed-out fetch's ssh child, so its lock could not be trusted.
  if (wslPathOf(cwd)) throw new WorktreeError("bad_request", "Fetch is not supported for WSL projects yet");
  const top = topIn(cwd, o.allowed);
  if (!top) return null;
  return exclusive(top, async () => {
    const base = { ...process.env, ...ceilingEnv(top), GIT_TERMINAL_PROMPT: "0" };
    const cfg = await local(top, ["config", "--get-regexp", "^(remote\\..+\\.url|core\\.sshcommand)$"], base);
    const names = new Set<string>();
    let sshCommand = "";
    for (const line of cfg.out.split("\n").filter(Boolean)) {
      const sp = line.indexOf(" ");
      const key = sp < 0 ? line : line.slice(0, sp);
      if (key.toLowerCase() === "core.sshcommand") sshCommand = line.slice(sp + 1);
      else names.add(key.slice(7, -4));
    }
    if (names.size === 0) throw new WorktreeError("bad_request", "No remote to fetch from");
    if (names.size > MAX_REMOTES) throw new WorktreeError("bad_request", `Too many remotes (${names.size}): fetch in a terminal`);
    const env = remoteEnv(top, sshCommand);
    await checkRemotes(top, [...names], false, env, o.allowed, o.platform ?? process.platform);
    const output = await remoteOp(top, "fetch", FETCH_ARGS, env);
    return { output, refs: gitRefs(top, o.allowed) };
  });
}
