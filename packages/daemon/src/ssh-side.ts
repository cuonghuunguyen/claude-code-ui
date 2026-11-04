// SSH sides (docs/spec.md "Sides"): hosts from ~/.ssh/config, the system `ssh` as transport, install from the Hub's bundle cache over ssh stdin.
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, sep } from "node:path";
import type { SideCheck, SidePhase, SideSetup } from "@claude-ui/protocol";
import { execRun, lastLines, packSide, sendBundle, streamTo, type BundleSource, type Exec } from "./docker-side.ts";
import { bundleParts, installMethodOf, safeKey, sideBuild } from "./side-bundle.ts";
import { blockedCheck, checkScript, hasBuild, parseCheck, shq, verdictOf, type SideBundle } from "./sides.ts";
import type { Runner } from "./update.ts";

/** A usable alias: no wildcard or negation, not read by `ssh` as an option, no whitespace, quote or control character. */
const isAlias = (a: string) => !!a && !/[*?!#"']/.test(a) && !a.startsWith("-") && !/[\s\x00-\x1f\x7f]/.test(a);

/** The `Host` aliases and `Include` patterns of a config text, in order. Quoted tokens keep their spaces; an unquoted # starts a comment. */
function configItems(text: string): ({ host: string } | { include: string })[] {
  const out: ({ host: string } | { include: string })[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(host|include)(?:\s*=\s*|\s+)(.*)$/i.exec(raw);
    if (!m) continue;
    const isHost = m[1]!.toLowerCase() === "host";
    for (const t of m[2]!.matchAll(/"([^"]*)"|#.*|(\S+)/g)) {
      const a = t[1] ?? t[2];
      if (!a) continue;
      if (!isHost) out.push({ include: a });
      else if (isAlias(a)) out.push({ host: a });
    }
  }
  return out;
}

/** The aliases of the `Host` lines of one config text: one per token, first occurrence wins, `isAlias` tokens only. `Include` is not followed here (listSshHosts does). */
export const parseSshConfig = (text: string): string[] => [...new Set(configItems(text).flatMap((i) => ("host" in i ? [i.host] : [])))];

/** The ssh config file the Hub uses instead of ~/.ssh/config: `CLAUDE_UI_SSH_CONFIG` (also passed to every ssh as `-F`); undefined: ssh's own default. */
export const sshConfigPath = (env: NodeJS.ProcessEnv = process.env): string | undefined => env.CLAUDE_UI_SSH_CONFIG || undefined;

/** What the config reader needs of the file system (a test seam). `read`: undefined for a missing or unreadable file; `list`: [] for a missing folder. */
export type ConfigFs = { read(file: string): string | undefined; list(dir: string): string[] };
const realFs: ConfigFs = {
  read: (f) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  },
  list: (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
};

/** One path segment with `*` and `?` as a regular expression. */
const segmentRe = (seg: string) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
const MAX_INCLUDE_DEPTH = 8;

/** The files an `Include` pattern names: `~` is the home folder, a relative path is relative to `base`, `*` and `?` match within one segment (sorted, no dot files unless the segment starts with a dot). */
export function includeFiles(pattern: string, base: string, home: string, fs: Pick<ConfigFs, "list"> = realFs): string[] {
  const p = pattern.startsWith("~/") || pattern === "~" ? join(home, pattern.slice(1)) : pattern;
  const abs = isAbsolute(p) ? p : join(base, p);
  const { root } = parsePath(abs);
  // shortcut: a backslash is a path separator only on Windows, where it cannot escape a glob character; no `[set]` or brace expansion
  let paths = [root];
  for (const seg of abs.slice(root.length).split(sep).filter(Boolean)) {
    if (!/[*?]/.test(seg)) paths = paths.map((d) => join(d, seg));
    else paths = paths.flatMap((d) => fs.list(d).filter((n) => segmentRe(seg).test(n) && (seg.startsWith(".") || !n.startsWith("."))).sort().map((n) => join(d, n)));
  }
  return paths;
}

/**
 * Host aliases of the ssh config (`config` path, else ~/.ssh/config) and of the files its `Include` lines name, in the order ssh reads
 * them; a repeated alias is listed once (first wins). A relative Include is relative to the config's folder (~/.ssh). [] when there is no file.
 * shortcut: an Include inside a Host or Match block counts as a top-level one; nesting stops at MAX_INCLUDE_DEPTH.
 */
export function listSshHosts(config?: string, fs: Partial<ConfigFs> = {}, home = homedir()): string[] {
  const f = { ...realFs, ...fs };
  const file = config ?? join(home, ".ssh", "config");
  // `stack`: the files being read now; a file that includes one of them (a cycle) adds nothing.
  const walk = (path: string, stack: string[]): string[] => {
    const text = stack.includes(path) ? undefined : f.read(path);
    if (text === undefined) return [];
    return configItems(text).flatMap((i) => ("host" in i ? [i.host] : stack.length >= MAX_INCLUDE_DEPTH ? [] : includeFiles(i.include, dirname(file), home, f).flatMap((inc) => walk(inc, [...stack, path]))));
  };
  return [...new Set(walk(file, []))];
}

/** What `ssh user@host -p N -i key -J jump` names. */
export type SshTarget = { host: string; user?: string; port?: number; identity?: string; jump?: string };

/**
 * The target of an `ssh [options] [user@]host` command line: options -p, -i, -J, -l and one destination. Anything else (other options,
 * a remote command, a missing host, characters that would change the config file) throws an Error with the reason.
 */
export function parseSshCommand(text: string): SshTarget {
  const tokens = [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
  if (tokens[0] === "ssh") tokens.shift();
  const o: Record<string, string> = {};
  let dest: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("-") || t === "-") {
      if (dest !== undefined) throw new Error(`Unexpected "${t}" after the host. Give only: ssh [user@]host [-p port] [-i key] [-J jump].`);
      dest = t;
      continue;
    }
    const flag = t.slice(0, 2);
    if (!["-p", "-i", "-J", "-l"].includes(flag)) throw new Error(`The ssh option ${flag} is not supported. Supported: -p, -i, -J, -l.`);
    const value = t.length > 2 ? t.slice(2) : tokens[++i];
    if (!value) throw new Error(`The ssh option ${flag} needs a value.`);
    o[flag] = value;
  }
  if (!dest) throw new Error("No host found. Example: ssh user@example.com -p 2222");
  const at = dest.lastIndexOf("@");
  const user = at >= 0 ? dest.slice(0, at) : o["-l"];
  const host = at >= 0 ? dest.slice(at + 1) : dest;
  if (!/^[A-Za-z0-9_][\w.:%-]*$/.test(host)) throw new Error(`"${host}" is not a valid host name.`);
  const clean = (v: string | undefined, what: string, spaces = false) => {
    if (v !== undefined && (/[\x00-\x1f\x7f"#]/.test(v) || (!spaces && /\s/.test(v)) || v.startsWith("-"))) throw new Error(`The ${what} "${v}" has characters that are not allowed.`);
    return v;
  };
  const port = o["-p"] === undefined ? undefined : Number(o["-p"]);
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw new Error(`"${o["-p"]}" is not a port (1 to 65535).`);
  return { host, ...(clean(user, "user") && { user }), ...(port !== undefined && { port }), ...(clean(o["-i"], "key path", true) && { identity: o["-i"] }), ...(clean(o["-J"], "jump host") && { jump: o["-J"] }) };
}

/**
 * Appends a `Host` block for an `ssh ...` command to the ssh config (`config`, else ~/.ssh/config), creating the file (0600) and its
 * folder (0700) when absent. The alias defaults to the host name. Refuses an alias the config (with its Includes) already lists.
 * Rename or remove: edit the file. Resolves with the alias; throws an Error with the reason.
 */
export function addSshHost(o: { command: string; alias?: string; config?: string; home?: string; fs?: Partial<ConfigFs> }): string {
  const t = parseSshCommand(o.command);
  const alias = o.alias?.trim() || t.host;
  if (!isAlias(alias)) throw new Error(`"${alias}" cannot be a host alias: no spaces, quotes or the characters * ? ! #, and no leading -.`);
  if (listSshHosts(o.config, o.fs, o.home).includes(alias)) throw new Error(`The host "${alias}" already exists in the ssh config. Pick another alias.`);
  const file = o.config ?? join(o.home ?? homedir(), ".ssh", "config");
  const old = (o.fs?.read ?? realFs.read)(file) ?? "";
  const q = (v: string) => (/\s/.test(v) ? `"${v}"` : v);
  const block = [`Host ${alias}`, `  HostName ${t.host}`, ...(t.user ? [`  User ${t.user}`] : []), ...(t.port ? [`  Port ${t.port}`] : []), ...(t.identity ? [`  IdentityFile ${q(t.identity)}`] : []), ...(t.jump ? [`  ProxyJump ${t.jump}`] : [])].join("\n");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${old && !old.endsWith("\n") ? "\n" : ""}${old ? "\n" : ""}# Added by Claude UI\n${block}\n`, { mode: 0o600 });
  return alias;
}

/**
 * `ssh` arguments that run `script` with `sh -c` on the host. No askpass, no password, host key checking as the user configured.
 * Base64 keeps newlines and quotes away from the remote login shell (fish and tcsh break on them).
 */
export const sshArgs = (alias: string, script: string, args: string[] = [], config?: string) => [
  "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", ...(config ? ["-F", config] : []), "--", alias,
  `sh -c ${shq(`eval "$(echo ${Buffer.from(script).toString("base64")} | base64 -d)"`)} sh ${args.map(shq).join(" ")}`.trimEnd(),
];

/** The message for an ssh run that failed in ssh itself (exit 255, or no answer); undefined: the remote command's own exit. */
export function sshError(alias: string, r: { code: number | null; stderr: string }): string | undefined {
  const label = `SSH: ${alias}`;
  if (r.code === null) return `${label} did not answer in time.`;
  if (r.code !== 255) return undefined;
  if (/Permission denied|Too many authentication failures/i.test(r.stderr)) return `${label}: the host refused the login (key or password needed). Run \`ssh ${alias}\` once in a terminal, then retry.`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(r.stderr)) return `${label}: the host key is not trusted yet. Run \`ssh ${alias}\` once in a terminal to check and accept it, then retry.`;
  return `${label} is not reachable: ${lastLines(r.stderr).replace(/\.$/, "") || "ssh failed"}.`;
}

/** Whether a probe run came from a Windows host: its OS name, or a cmd.exe or PowerShell default shell that has no `sh`. */
export const isWindowsHost = (r: { stdout: string; stderr: string }) => /^CLAUDE_UI_CHECK os=(MINGW|MSYS|CYGWIN|Windows)/im.test(r.stdout) || /is not recognized as/i.test(r.stderr);
const WINDOWS = "Windows SSH hosts are not supported yet";

/**
 * Before the launch: one ssh run probes the host (OS, target, what is installed). A Windows host is refused. A host that already has this
 * build skips the install (nothing is sent). A covered Linux host gets the bundle (assembled from the Hub's verified parts) through ssh
 * stdin; any other POSIX host (musl, other arch, macOS, BSD) gets the npm tarball and installs with its own Node.js. An automatic update
 * (`bundleOnly`) never uses npm. Resolves with the path on the host (`never`: run what is installed) and the bundle; rejects with the
 * user's next step. Setup `never`: nothing is probed or sent.
 */
export async function prepareSshSide(o: {
  alias: string;
  pkgDir: string;
  key: string;
  /** Where the npm tarball is packed (kept per key). */
  cacheDir: string;
  npm?: Runner;
  setup?: SideSetup;
  pinned?: boolean;
  bundleOnly?: boolean;
  /** ssh config file (`-F`). */
  config?: string;
  exec?: Exec;
  onPhase?: (p: SidePhase) => void;
  onInstall?: (i: { bundle: true } | { fallback: string }) => void;
  bundle: BundleSource;
}): Promise<{ path: string; bundle?: SideBundle; never?: true }> {
  const exec = o.exec ?? execRun;
  const label = `SSH: ${o.alias}`;
  if (o.setup === "never") return { path: "" };
  const run = async (script: string, args: string[], ms: number, stdin?: string) => {
    const r = await exec("ssh", sshArgs(o.alias, script, args, o.config), ms, stdin);
    const err = sshError(o.alias, r);
    if (err) throw new Error(err);
    return r;
  };
  const probe = await run(checkScript(o.key, "ssh"), [], 30_000);
  if (isWindowsHost(probe)) throw new Error(`${label}: ${WINDOWS}.`);
  // Reconnecting: this build is there, so nothing is packed or sent (force and a Node.js that did not start it install again).
  if (parseCheck(probe.stdout)?.installed === "current" && o.setup !== "force" && !o.pinned) return { path: "", never: true };
  const sent = await sendBundle(
    { noun: "host", probe: async () => probe, send: (file, name) => streamTo(run, label, file, name, "host") },
    { pinned: o.pinned, pkgDir: o.pkgDir, key: o.key, onPhase: o.onPhase, onInstall: o.onInstall },
    o.bundle,
  );
  if ("path" in sent) return sent;
  o.onInstall?.({ fallback: sent.fallback });
  if (o.bundleOnly) return { path: "", never: true };
  o.onPhase?.("packing");
  mkdirSync(o.cacheDir, { recursive: true });
  const tgz = await packSide({ pkgDir: o.pkgDir, key: o.key, cacheDir: o.cacheDir, label, npm: o.npm });
  o.onPhase?.("copying");
  return { path: await streamTo(run, label, tgz, `claude-ui-side-${safeKey(o.key)}.tgz`, "host") };
}

/** `side.check` of a host: read-only, one ssh run of the check script. */
export async function checkSshSide(o: { alias: string; config?: string; pkgDir: string; key: string; exec?: Exec; timeoutMs?: number; bundle?: BundleSource }): Promise<SideCheck> {
  const label = `SSH: ${o.alias}`;
  const noun = "host";
  const r = await (o.exec ?? execRun)("ssh", sshArgs(o.alias, checkScript(o.key, "ssh"), [], o.config), o.timeoutMs ?? 30_000);
  const err = sshError(o.alias, r);
  if (err) return { ...blockedCheck(o.key, label, "unreachable", { noun }), message: err };
  if (isWindowsHost(r)) return blockedCheck(o.key, label, "windows_host", { noun, reachable: true });
  const checked = parseCheck(r.stdout);
  if (!checked) return blockedCheck(o.key, label, "check_failed", { noun, detail: lastLines(r.stderr).replace(/\.$/, "") || `exit code ${r.code}` });
  const build = sideBuild(o.pkgDir);
  const m = installMethodOf(checked.target, !!build, noun);
  return verdictOf({ key: o.key, label, kind: "ssh", noun, build: hasBuild(o.pkgDir, true), checked, install: m.method === "bundle" ? { method: "bundle", ...(o.bundle && { parts: bundleParts(o.bundle, m, build!.sdkVersion) }) } : m });
}
