// WSL distros (Windows) and running Linux Docker containers (any OS) (docs/spec.md "Sides"): the daemon (hub) also serves each
// of them through a side: the same daemon run inside the distro or container with `--side`, without HTTP, speaking the wire protocol over its stdio. The hub routes each
// browser request to the side that owns its session, terminal or path; one URL, one pairing, one page for every side.
// Frames are JSON lines. hub -> side: {c, o} opens virtual connection c, {c, m} a client message, {c, x} closes it.
// side -> hub: {ready} once listening, {c, m} a server message, {push} a Web Push payload. Other stdout lines are ignored.
// Git of a WSL project the hub opened by its Windows path: hub -> side {g, git: {cwd, args, env, input?, timeout?, maxBuffer?}} runs git in
// the side; side -> hub {g, out: <base64 stdout>, err, error?: {message, code?, killed, signal?}} answers it (`wsl-git.ts`).
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { Readable, Writable } from "node:stream";
import { perf, type PerfSpanHandle } from "./perf.ts";
import { LOCAL_SIDE, type ClientMessage, type PushPayload, type ServerMessage, type SettingsResult, type Settings, type SideCheck, type SideCheckFacts, type SideCheckReason, type DockerState, type SideInfo, type SidePhase, type SideSetup } from "@claude-ui/protocol";
import type { Exec } from "./docker-side.ts";
import type { GitRunOptions, GitRunOutput, GitRunner } from "./git-runner.ts";
import { SideGone } from "./wsl-git.ts";
import { MEDIA_PIECE_TIMEOUT_MS } from "./media.ts";
import type { Push } from "./push.ts";
import { logPrefix, MAX_SIDE_LINE_CHARS, parseSideFrame } from "./side-frame.ts";
export { MAX_SIDE_LINE_CHARS };

/** A started side process: `wsl.exe -d <distro> ...` or `docker exec -i <name> ...` (tests: an in-process side). */
export type SideProcess = { stdin: Writable; stdout: Readable; stderr: Readable; kill(): void; on(event: "exit", l: (code: number | null) => void): unknown };

/** A browser connection's view of one side. */
type Conn = { send(m: ClientMessage): void; close(): void };

/** Distro names from `wsl.exe -l -q` (UTF-16LE; UTF-8 with WSL_UTF8=1). Docker and Rancher Desktop distros are no user side. */
export function parseDistros(out: Buffer) {
  const text = out.includes(0) ? out.toString("utf16le") : out.toString("utf8");
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^﻿/, "").trim())
    .filter((d) => d && !/^(docker-desktop|rancher-desktop)/.test(d));
}

/** A side the hub can start. */
export type SideTarget = { id: string; label: string };
export const wslSide = (distro: string): SideTarget => ({ id: `wsl:${distro}`, label: `WSL: ${distro}` });
export const dockerSide = (name: string): SideTarget => ({ id: `docker:${name}`, label: `Docker: ${name}` });
const isDocker = (id: string) => id.startsWith("docker:");

/** Setup errors the side's start script reports as `CLAUDE_UI_SETUP <code> <detail>`. */
export function setupMessage(code: string, detail: string, side: string, docker = false) {
  switch (code) {
    case "node_missing":
      return docker ? `Node.js 22 or newer is not installed in ${side}. Use an image with Node.js 22+ (e.g. node:22) or install it in the container, then retry.` : `Node.js 22 or newer is not installed in ${side}. Install it there (e.g. nvm install 22), then retry.`;
    case "node_old":
      return docker ? `Node.js ${detail} in ${side} is too old: 22 or newer is needed. Use an image with Node.js 22+ (e.g. node:22), then retry.` : `Node.js ${detail} in ${side} is too old: 22 or newer is needed. Update it there (e.g. nvm install 22), then retry.`;
    case "not_logged_in":
      return docker ? `Claude is not logged in to ${side}. Run claude login in the container or copy your ~/.claude/.credentials.json into it (or start it with ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set), then retry.` : `Claude is not logged in to ${side}. Run claude login there, then retry.`;
    case "build_tools_missing":
      return `${side} needs make, python3 and g++ to build the terminal support (node-pty). Install them there (Debian/Ubuntu: apt-get install -y make python3 g++; Alpine: apk add make python3 g++), then retry.`;
    case "not_installed":
      return `claude-ui is not installed in ${side} yet. Install it first.`;
    case "install_failed":
      return `Installing claude-ui in ${side} failed${detail ? `: ${detail}` : ""}. Check its network and npm, then retry.`;
    default:
      return `${side} could not start (${code}${detail ? ` ${detail}` : ""}).`;
  }
}

/**
 * Shell script run in the side: POSIX sh in a container (the image's environment; nvm sourced when present), bash -lic in a WSL
 * distro (nvm and PATH from .bashrc). Checks Node 22+ and the Claude login, then installs this claude-ui's package once per
 * `key` (version and build), so no registry or unpublished version matters. wsl: `source` is the Windows package folder (read
 * through /mnt; npm packs it); docker: `source` is the tarball's path in the container. Then runs it.
 */
export function setupScript(source: string, key: string, kind: "wsl" | "docker" = "wsl", mode: SideSetup = "needed") {
  const docker = kind === "docker";
  // never: only an installed build runs (else `not_installed`, the side stays off); force: installed again whatever is there.
  const never = mode === "never";
  const src = source.replace(/'/g, "");
  return [
    "say() { printf 'CLAUDE_UI_SETUP %s\\n' \"$*\"; exit 3; }",
    ...(docker ? ['nvm="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm" ] && . "$nvm" >/dev/null 2>&1'] : []),
    "command -v node >/dev/null 2>&1 || say node_missing",
    "v=$(node -p 'process.versions.node.split(\".\")[0]') || say node_missing",
    "[ \"$v\" -ge 22 ] || say node_old \"$(node -v)\"",
    "[ -n \"$ANTHROPIC_API_KEY\" ] || [ -n \"$CLAUDE_CODE_OAUTH_TOKEN\" ] || [ -f \"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json\" ] || say not_logged_in",
    'root="$HOME/.local/share/claude-ui/side"',
    `dir="$root/${key.replace(/[^\w.-]/g, "_")}"`,
    'cli="$dir/node_modules/claude-code-ui/dist/cli.js"',
    ...(docker && !never ? [`src='${src}'`] : []),
    // npm skips an optional dependency it could not fetch: without the SDK's Linux binary (any arch or libc) the side lists no
    // models (no auto mode) and runs no query. Such an install is installed again: into an empty temp folder next to the old
    // install (npm does not fetch a missing optional dependency into an existing node_modules), checked there (dist/cli.js and the
    // binary), then swapped in. On any failure the old install stays (disk: both exist while npm runs).
    'sdk() { for b in "$1"/node_modules/@anthropic-ai/claude-agent-sdk-linux-*; do [ -d "$b" ] && return 0; done; return 1; }',
    ...(never
      ? ['if [ ! -f "$cli" ] || ! sdk "$dir"; then say not_installed; fi']
      : [
    mode === "force" ? "if true; then" : 'if [ ! -f "$cli" ] || ! sdk "$dir"; then',
    docker
      ? `  [ -f "$src" ] || say install_failed "the claude-ui package was not copied in"`
      : `  src=$(wslpath -u '${src}') && [ -f "$src/dist/cli.js" ] || say install_failed "the Windows claude-ui package was not found"`,
    "  printf 'CLAUDE_UI_PHASE %s\\n' installing",
    // node-pty has no Linux prebuilds: npm install compiles it.
    "  { command -v make && command -v python3 && { command -v g++ || command -v c++; }; } >/dev/null 2>&1 || say build_tools_missing",
    // Dot names: the sweep of earlier versions below ("$root"/*) never matches them.
    '  new="$root/.new-$$"; old="$root/.old-$$"',
    '  rm -rf "$new"; mkdir -p "$new" || say install_failed',
    `  out=$(npm install --prefix "$new" ${docker ? "" : "--install-links "}--omit=dev --no-save --no-fund --no-audit --loglevel=error "$src" 2>&1 >/dev/null) || { rm -rf "$new"; say install_failed "$(printf '%s' "$out" | tail -n 3 | tr '\\n' ' ')"; }`,
    '  [ -f "$new/node_modules/claude-code-ui/dist/cli.js" ] || { rm -rf "$new"; say install_failed "the package has no dist/cli.js"; }',
    '  sdk "$new" || { rm -rf "$new"; say install_failed "npm did not install the Claude Agent SDK binary for Linux (an optional dependency)"; }',
    // The new install must run (node exits non-zero on a missing or unloadable dependency) before it replaces the old one.
    '  node "$new/node_modules/claude-code-ui/dist/cli.js" --version >/dev/null 2>&1 || { rm -rf "$new"; say install_failed "the new install does not start"; }',
    // Swap: mv onto an existing folder would move into it, so the old one moves aside first (put back if the new one cannot move in).
    '  if [ -e "$dir" ]; then mv "$dir" "$old" || { rm -rf "$new"; say install_failed "the old install could not be moved aside"; }; fi',
    '  mv "$new" "$dir" || { rm -rf "$dir" "$new"; [ -e "$old" ] && mv "$old" "$dir"; say install_failed "the new install could not be moved in"; }',
    '  rm -rf "$old"',
    // Earlier versions and builds, leftovers of killed runs.
    '  for d in "$root"/* "$root"/.new-* "$root"/.old-*; do [ "$d" = "$dir" ] || rm -rf "$d"; done',
    "fi",
    ]),
    ...(docker && !never ? ['rm -f "$src" 2>/dev/null'] : []),
    ...(docker ? ['[ -n "$CLAUDE_UI_ROOTS" ] || case "$PWD" in /|"$HOME"|"$HOME"/*) export CLAUDE_UI_ROOTS="$HOME" ;; *) export CLAUDE_UI_ROOTS="$HOME:$PWD" ;; esac'] : []),
    "printf 'CLAUDE_UI_PHASE %s\\n' starting",
    'exec node "$cli" --side',
  ].join("\n");
}

/** Whether this claude-ui has the build a side installs: dist/cli.js (a Docker side also serves dist/web/index.html). */
export const hasBuild = (pkgDir: string, docker: boolean) => existsSync(join(pkgDir, "dist", "cli.js")) && (!docker || existsSync(join(pkgDir, "dist", "web", "index.html")));

/**
 * Read-only script for `side.check`, run where the setup script runs (same shell, same nvm): prints `CLAUDE_UI_CHECK <k>=<v>` lines
 * (node, make, python3, cxx, credentials, package [wsl], writable [docker], then installed and installedKey). It never installs,
 * writes, copies, starts the side, reads a file's contents or prints an environment variable's value: HOME, PATH, NVM_DIR and
 * CLAUDE_CONFIG_DIR only name places (a writable home folder is reported as the text $HOME).
 */
export function checkScript(key: string, kind: "wsl" | "docker", source = "") {
  const docker = kind === "docker";
  return [
    "emit() { printf 'CLAUDE_UI_CHECK %s=%s\\n' \"$1\" \"$2\"; }",
    ...(docker ? ['nvm="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm" ] && . "$nvm" >/dev/null 2>&1'] : []),
    "if command -v node >/dev/null 2>&1; then emit node \"$(node -p 'process.versions.node' 2>/dev/null || echo none)\"; else emit node none; fi",
    "command -v make >/dev/null 2>&1 && emit make 1 || emit make 0",
    "command -v python3 >/dev/null 2>&1 && emit python3 1 || emit python3 0",
    "{ command -v g++ || command -v c++; } >/dev/null 2>&1 && emit cxx 1 || emit cxx 0",
    '[ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ] && emit credentials 1 || emit credentials 0',
    ...(docker
      ? [`w=; wr() { [ -d "$1" ] && [ -w "$1" ] && w="$w\${w:+,}$2"; }; wr /tmp /tmp; wr /dev/shm /dev/shm; wr "$HOME" '$HOME'; emit writable "$w"`]
      : [`src=$(wslpath -u '${source.replace(/'/g, "")}' 2>/dev/null) && [ -f "$src/dist/cli.js" ] && emit package 1 || emit package 0`]),
    'root="$HOME/.local/share/claude-ui/side"',
    `dir="$root/${key.replace(/[^\w.-]/g, "_")}"`,
    'sdk() { for b in "$1"/node_modules/@anthropic-ai/claude-agent-sdk-linux-*; do [ -d "$b" ] && return 0; done; return 1; }',
    // Same test as the setup script: a build without the SDK's Linux binary is not installed.
    'if [ -f "$dir/node_modules/claude-code-ui/dist/cli.js" ] && sdk "$dir"; then emit installed current',
    'else o=; for d in "$root"/*; do [ -d "$d" ] && [ "$d" != "$dir" ] && o="${d##*/}" && break; done',
    '  if [ -n "$o" ]; then emit installed other; emit installedKey "$o"',
    '  elif [ -d "$dir" ]; then emit installed other; emit installedKey "${dir##*/}"',
    "  else emit installed none; fi",
    "fi",
  ].join("\n");
}

type Checked = {
  node?: string;
  make: boolean;
  python3: boolean;
  cxx: boolean;
  credentials: boolean;
  /** WSL: the Windows package is readable from the distro. */
  packageVisible?: boolean;
  /** Docker: writable folders. */
  writable?: string[];
  installed: "current" | "other" | "none";
  installedKey?: string;
};

/** The `CLAUDE_UI_CHECK` lines of a check script's output (other lines are shell start-up noise); undefined when the script did not get to its last line. */
export function parseCheck(out: string): Checked | undefined {
  const kv = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^CLAUDE_UI_CHECK ([a-zA-Z0-9]+)=(.*)$/.exec(line.trim());
    if (m) kv.set(m[1]!, m[2]!.trim());
  }
  const inst = kv.get("installed");
  if (inst !== "current" && inst !== "other" && inst !== "none") return undefined;
  const node = kv.get("node");
  const flag = (k: string) => kv.get(k) === "1";
  return {
    ...(node && node !== "none" && { node }),
    make: flag("make"),
    python3: flag("python3"),
    cxx: flag("cxx"),
    credentials: flag("credentials"),
    ...(kv.has("package") && { packageVisible: flag("package") }),
    ...(kv.has("writable") && { writable: kv.get("writable")!.split(",").filter(Boolean) }),
    installed: inst,
    ...(kv.get("installedKey") && { installedKey: kv.get("installedKey") }),
  };
}

const nodeMajor = (v: string) => Number(/^v?(\d+)/.exec(v)?.[1] ?? NaN);

/** The user's next step for a blocked check, in plain words (same source as `setupMessage`). `side`: the label; `detail`: a version, a name or a short reason. */
export function checkMessage(reason: SideCheckReason, side: string, o: { docker?: boolean; detail?: string; name?: string } = {}) {
  const d = o.detail ?? "";
  switch (reason) {
    case "gone":
      return `${side} no longer exists. Pick another container.`;
    case "not_running":
      return `${side} is not running. Start it${o.name ? ` (docker start ${o.name})` : ""}, then check again.`;
    case "unreachable":
      return `${side} could not be reached${d ? `: ${d}` : ""}. Make sure it is available, then check again.`;
    case "no_build":
      return "This version of Claude UI has no complete build yet. Wait for a running build to finish, or run npm start, then check again.";
    case "package_unreadable":
      return `${side} cannot read the claude-ui files on Windows. Wait for a running build to finish, then check again.`;
    case "node_missing":
      return o.docker ? `Node.js is not installed in ${side}. Use an image with Node.js 22 or newer (for example node:22), or install it in the container. Then check again.` : `Node.js is not installed in ${side}. Install version 22 or newer there (for example nvm install 22). Then check again.`;
    case "node_old":
      return o.docker ? `Node.js ${d} in ${side} is too old. Version 22 or newer is needed. Use an image with Node.js 22 or newer (for example node:22). Then check again.` : `Node.js ${d} in ${side} is too old. Version 22 or newer is needed. Update it there (for example nvm install 22). Then check again.`;
    case "build_tools_missing":
      return `${side} needs ${d || "make, python3 and g++"} to install the terminal support. Install ${d ? "it" : "them"} there (Debian or Ubuntu: apt-get install -y make python3 g++; Alpine: apk add make python3 g++). Then check again.`;
    case "not_logged_in":
      return o.docker ? `Claude does not look logged in to ${side}. Run claude login in the container, or copy your ~/.claude/.credentials.json into it. If it logs in with an API key or token, you can install anyway.` : `Claude does not look logged in to ${side}. Run claude login there. If it logs in with an API key or token, you can install anyway.`;
    case "no_writable_path":
      return `${side} has no folder claude-ui can be put in: /tmp, /dev/shm and the home folder are read-only. Start the container with a writable /tmp (docker run --tmpfs /tmp), then check again.`;
    case "check_failed":
      return `The check of ${side} did not finish${d ? `: ${d}` : ""}. Check again.`;
  }
}

/**
 * The verdict for a side that runs: first hard blocks (no build, Node.js, and only when an install is needed: no writable folder,
 * build tools, the package unreadable), then an installed side (starting it needs no login), then the soft block (no credentials
 * file: an environment login cannot be seen; only when an install or update is needed). `cpUsable` (Docker): whether `docker cp` can write; with a writable folder one of the two copies the package in.
 */
export function verdictOf(o: { key: string; label: string; kind: "wsl" | "docker"; name?: string; build: boolean; checked: Checked; cpUsable?: boolean }): SideCheck {
  const { checked: c, key, label } = o;
  const docker = o.kind === "docker";
  const nodeOk = c.node ? nodeMajor(c.node) >= 22 : undefined;
  const facts: SideCheckFacts = {
    reachable: true,
    ...(docker && { running: true }),
    ...(c.node && { node: c.node, nodeOk }),
    buildTools: { make: c.make, python3: c.python3, cxx: c.cxx },
    credentialsFile: c.credentials,
    installed: c.installed,
    ...(c.installedKey && { installedKey: c.installedKey }),
    ...(c.writable && { writable: c.writable }),
  };
  const blocked = (reason: SideCheckReason, detail?: string): SideCheck => ({ verdict: "blocked", reason, message: checkMessage(reason, label, { docker, detail, name: o.name }), key, facts });
  const needsInstall = c.installed !== "current";
  if (!o.build) return blocked("no_build");
  if (!c.node) return blocked("node_missing");
  if (!nodeOk) return blocked("node_old", c.node);
  if (needsInstall) {
    if (docker && o.cpUsable === false && c.writable && c.writable.length === 0) return blocked("no_writable_path");
    const missing = [!c.make && "make", !c.python3 && "python3", !c.cxx && "g++"].filter(Boolean) as string[];
    if (missing.length) return blocked("build_tools_missing", missing.join(", "));
    if (!docker && c.packageVisible === false) return blocked("package_unreadable");
  }
  // Installed (this build, complete): nothing to set up, so a missing credentials file (an environment login is invisible) does not block it.
  if (c.installed === "current") return { verdict: "installed", key, facts };
  if (!c.credentials) return blocked("not_logged_in");
  const verdict = c.installed === "other" ? "update" : "install";
  return { verdict, message: verdict === "update" ? `${label} has an older claude-ui. Update it to use it with this one.` : `claude-ui is not installed in ${label}. Install it to use it.`, key, facts };
}

/** A blocked verdict for a side that could not be asked (no answer, gone, not running). */
export const blockedCheck = (key: string, label: string, reason: SideCheckReason, o: { docker?: boolean; detail?: string; name?: string; reachable?: boolean; running?: boolean } = {}): SideCheck => ({
  verdict: "blocked",
  reason,
  message: checkMessage(reason, label, o),
  key,
  facts: { reachable: o.reachable ?? false, ...(o.running !== undefined && { running: o.running }), installed: "none" },
});

/** WSL: runs the check script in the distro (`wsl.exe` boots a stopped distro, nothing else changes). */
export async function checkWslSide(o: { distro: string; pkgDir: string; key: string; exec: Exec; timeoutMs?: number }): Promise<SideCheck> {
  const label = wslSide(o.distro).label;
  const r = await o.exec("wsl.exe", wslArgs(o.distro, checkScript(o.key, "wsl", o.pkgDir)), o.timeoutMs ?? 30_000);
  const checked = parseCheck(r.stdout);
  if (!checked) {
    const err = r.stderr.replace(/\0/g, "").trim().split(/\r?\n/).slice(-2).join(" ").trim();
    return blockedCheck(o.key, label, r.code === null ? "unreachable" : "check_failed", { detail: r.code === null ? err || "no answer in time" : err || `exit code ${r.code}` });
  }
  return verdictOf({ key: o.key, label, kind: "wsl", build: hasBuild(o.pkgDir, false), checked });
}

/** Arguments for wsl.exe: the script travels base64-encoded (no quotes or newlines in the Windows command line) and is sourced. */
export const wslArgs = (distro: string, script: string) => ["-d", distro, "--exec", "bash", "-lic", `. <(echo ${Buffer.from(script).toString("base64")} | base64 -d)`];

/** Arguments for docker.exe: the script is one argv item for `sh -c` (no shell on the host; the image's environment, not a login shell). */
export const dockerExecArgs = (name: string, script: string) => ["exec", "-i", name, "sh", "-c", script];

/** `onPush` of the hub: a side's push goes to the user's browsers or desktop; a failure is logged, never an unhandled rejection. */
export const forwardSidePush = (push: Pick<Push, "send">) => (p: PushPayload) => void push.send(p).catch((e) => console.error("push from a side failed:", (e as Error).message));

/**
 * Calls `onLine` for each complete line of `stream`. A line longer than `max` characters is dropped (`onTooLong` once, with its
 * length so far when the cap was hit): it is never buffered beyond `max`, the next line is read normally.
 */
function lines(stream: Readable, onLine: (line: string) => void, max = Infinity, onTooLong?: () => void) {
  let rest = "";
  let skipping = false;
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    const parts = d.split("\n");
    const last = parts.pop()!;
    for (const [i, part] of parts.entries()) {
      const line = i === 0 ? rest + part : part;
      rest = "";
      if (skipping) skipping = false;
      else if (line.length > max) onTooLong?.();
      else onLine(line);
    }
    if (skipping) return;
    rest = parts.length ? last : rest + last;
    if (rest.length > max) (skipping = true), (rest = ""), onTooLong?.();
  });
}

type GitCall = { ok: (o: GitRunOutput) => void; fail: (e: Error) => void; timer: NodeJS.Timeout };
type Side = SideInfo & { proc?: SideProcess; starting?: Promise<void>; conns: Map<number, (m: ServerMessage) => void>; gits: Map<number, GitCall> };

let nextGit = 0;


/** Longest wait for one side's list when the hub looks up an unlisted session ID (GH-328). */
export const LOOKUP_TIMEOUT_MS = 5_000;

/** A path a side may claim as a cwd: absolute, normalized, no trailing slash (GH-320: other spellings slip past prefix checks). */
const canonical = (p: string) => p.startsWith("/") && !p.includes("\0") && posix.normalize(p) === p && (p === "/" || !p.endsWith("/"));
/** `p` is `dir` or inside it (POSIX). */
const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");

/**
 * The WSL and Docker sides of a daemon. `spawn` starts a side process for a side ID; `saved`/`save`: the sides started before
 * (they start again with the daemon, so their projects are back after a restart). `onChange`: a side's state changed.
 */
export function createSides(opts: {
  /** Static sides (WSL distros). */
  targets: SideTarget[];
  spawn: (id: string, o: { setup: SideSetup; phase: (p: SidePhase) => void }) => SideProcess | Promise<SideProcess>;
  /** Read-only look at a side that is not running (`side.check`); this claude-ui's build key is `key`. */
  check?: (id: string) => Promise<SideCheck>;
  key?: () => string;
  /** Longest a check may take (default 30 s: a stopped WSL distro boots). */
  checkMs?: number;
  /** Label of this daemon's own side (default "Windows"). */
  localLabel?: string;
  /** Dynamic sides (Docker containers), called by refresh(); never rejects (returns [] on failure). */
  discover?: () => Promise<SideTarget[]>;
  /** The Docker engine state found by the last discover() (`session.list` reply `docker`); undefined: unknown yet or no docker command. */
  dockerState?: () => DockerState | undefined;
  /** Minimum ms between two discover() runs (default 5000; tests 0). */
  discoverMs?: number;
  onPush?: (p: PushPayload) => void;
  saved?: string[];
  save?: (ids: string[]) => void;
  /** Local paths can be POSIX too (Linux, macOS): an unknown POSIX path then stays local. */
  posixLocal?: boolean;
  /** Folders that are this computer's whatever a side says (hub home and roots, POSIX hub); default: the home folder when posixLocal. */
  localDirs?: string[];
  /** Whether the hub has this path (default: the file system when posixLocal, else never). A side never claims an existing folder inside a local dir (GH-328). */
  localPathExists?: (p: string) => boolean;
  /** Longest line a side may write (default MAX_SIDE_LINE_CHARS; tests lower it). */
  maxLineChars?: number;
}) {
  const sides = new Map<string, Side>(opts.targets.map((t) => [t.id, { ...t, state: "off", conns: new Map(), gits: new Map() }]));
  const localDirs = (opts.localDirs ?? (opts.posixLocal ? [homedir()] : [])).map((p) => posix.normalize(p).replace(/(.)\/+$/, "$1")).filter(canonical);
  const routers = new Set<Router>();
  const changeListeners = new Set<() => void>();
  const changed = () => changeListeners.forEach((l) => l());
  let nextConn = 1;
  /** Sides started once: they start again with the next daemon start (a saved ID not seen yet stays saved). */
  const started = new Set(opts.saved ?? []);
  /** Started again once per daemon run. */
  const autoTried = new Set<string>();
  const autoStart = (id: string) => {
    if (!started.has(id) || autoTried.has(id)) return;
    autoTried.add(id);
    // Runs what is installed only: a claude-ui update is not installed silently (the side then offers Update).
    start(id, "never").catch((e) => console.error(`starting ${id} failed:`, (e as Error).message));
  };
  /** Session ID -> side, terminal ID -> side, project/session cwd -> side (not local ones). */
  const sessionSide = new Map<string, string>();
  const terminalSide = new Map<string, string>();
  const cwdSide = new Map<string, string>();
  /** Permission and question request ID -> the side that raised it; shared by every connection, so a reconnect still answers it. Bounded; a side's entries go when it exits. */
  const requestSide = new Map<string, string>();
  /** Each side's request IDs, oldest first: the cap is per side, so a side cannot push another side's request out. */
  const requestsOf = new Map<string, Set<string>>();
  const MAX_REQUESTS_PER_SIDE = 1000;
  /** Forgets a request; with `side`, only when that side owns it. */
  function forgetRequest(requestId: string, side?: string) {
    const owner = requestSide.get(requestId);
    if (!owner || (side && owner !== side)) return;
    requestSide.delete(requestId);
    requestsOf.get(owner)?.delete(requestId);
  }
  function noteRequest(id: string, p: { type?: unknown; requestId?: unknown; settled?: unknown } | undefined) {
    if (!p || (p.type !== "permission_request" && p.type !== "question") || typeof p.requestId !== "string") return;
    if (p.settled) return forgetRequest(p.requestId, id);
    // Another side's request ID stays with its first owner.
    if (requestSide.has(p.requestId)) return;
    requestSide.set(p.requestId, id);
    const mine = requestsOf.get(id) ?? requestsOf.set(id, new Set()).get(id)!;
    mine.add(p.requestId);
    // At the cap this side's oldest goes, never another side's.
    if (mine.size > MAX_REQUESTS_PER_SIDE) forgetRequest(mine.values().next().value!);
  }
  /** Per side, the clash causes it already showed a notice for in this run (GH-328: each cause shows once). */
  const clashed = new Map<string, Set<"local" | "other">>();
  /** Session IDs two or more sides named while no side owned them (GH-321): no side gets them for this hub run (GH-328: a contender exiting does not hand them to the others). */
  const contested = new Set<string>();
  const MAX_CONTESTED = 1000;
  function contest(sessionId: string, ids: string[]) {
    contested.delete(sessionId);
    contested.add(sessionId);
    if (contested.size > MAX_CONTESTED) contested.delete(contested.values().next().value!);
    for (const id of ids) clash(id, sessionId, true);
  }
  /** A side named a session ID the local daemon has or another side names: left out; says so once per cause (log) and in the side's message. */
  function clash(id: string, sessionId: string, other = false) {
    const s = sides.get(id);
    const cause = other ? "other" : "local";
    const seen = clashed.get(id) ?? new Set<"local" | "other">();
    if (!s || seen.has(cause)) return;
    clashed.set(id, seen.add(cause));
    console.error(`side ${id}: session ${sessionId} ${other ? "is named by another side too" : "exists on this computer too"}: left out (a shared ~/.claude?); other such sessions are left out silently`);
    if (s.state === "ready") {
      s.message =
        seen.size > 1
          ? `Some sessions of ${s.label} are left out: their IDs also exist on this computer or on another side (is ~/.claude shared?).`
          : `Some sessions of ${s.label} are left out: ${other ? "another side lists the same IDs" : "their IDs also exist on this computer"} (is ~/.claude shared${other ? "" : " with it"}?).`;
      changed();
    }
  }
  const write = (s: Side, frame: object) => {
    try {
      s.proc?.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // Exited: its exit handler resets it.
    }
  };

  // Performance monitor spans (GH-272) of a start in progress; the whole start, its install phase and the wait for the first frame.
  const spans = new WeakMap<Side, { top: PerfSpanHandle; install?: PerfSpanHandle; frame?: PerfSpanHandle }>();
  const endSpans = (s: Side, all = true) => {
    const o = spans.get(s);
    if (!o) return;
    o.install?.end();
    o.frame?.end();
    o.install = o.frame = undefined;
    if (all) (o.top.end(), spans.delete(s));
  };
  const setPhase = (s: Side, phase: SidePhase | undefined) => {
    if (s.phase === phase || (phase && s.state !== "starting")) return;
    const o = spans.get(s);
    if (o) {
      o.install?.end();
      o.install = phase === "installing" ? perf.span("side.install", o.top) : undefined;
    }
    if (phase) s.phase = phase;
    else delete s.phase;
    changed();
  };

  function start(id: string, setup: SideSetup = "needed"): Promise<void> {
    const s = sides.get(id);
    if (!s) return Promise.reject(new Error(`unknown side ${id}`));
    if (s.state === "ready") return Promise.resolve();
    if (s.starting) return s.starting;
    delete s.phase;
    Object.assign(s, { state: "starting", message: undefined });
    changed();
    spans.set(s, { top: perf.span("side.start") });
    s.starting = (async () => {
      let proc: SideProcess;
      const spawning = perf.span("side.spawn", spans.get(s)?.top);
      try {
        proc = await opts.spawn(s.id, { setup, phase: (p) => setPhase(s, p) });
        spawning.end();
        const o = spans.get(s);
        if (o) o.frame = perf.span("side.firstFrame", o.top);
      } catch (e) {
        spawning.end();
        const raw = (e as Error).message;
        const message = raw.startsWith(s.label) ? raw : `${s.label}: ${raw}`;
        delete s.phase;
        Object.assign(s, { state: "error", message, proc: undefined });
        changed();
        throw new Error(message);
      }
      await new Promise<void>((resolve, reject) => {
      s.proc = proc;
      let setupError: string | undefined;
      let setupCode: string | undefined;
      let stderr = "";
      // The tail below keeps 2000 chars; a long stack would push the crash line out, so it is remembered as it arrives
      // (`partial` carries an unfinished line over to the next chunk).
      const CRASH = /claude-ui daemon: (?:uncaughtException|unhandledRejection): (.*)/;
      let crashLine: string | undefined;
      let partial = "";
      proc.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d).slice(-2000);
        const rows = (partial + d).split("\n");
        partial = rows.pop()!.slice(-2000);
        for (const row of rows) crashLine = CRASH.exec(row)?.[1] ?? crashLine;
      });
      proc.stdin.on("error", () => {});
      let dropped = 0;
      lines(proc.stdout, (line) => {
        const phase = /^CLAUDE_UI_PHASE (installing|starting)$/.exec(line.trim());
        if (phase) return setPhase(s, phase[1] as SidePhase);
        const setup = /^CLAUDE_UI_SETUP (\S+) ?(.*)$/.exec(line.trim());
        if (setup) return void ((setupCode = setup[1]), (setupError = setupMessage(setup[1]!, setup[2]!, s.label, isDocker(s.id))));
        const parsed = parseSideFrame(line);
        if ("error" in parsed) {
          // Before the first frame this is shell start-up output (motd, .bashrc): not logged. Later lines are logged, at most 20 per run.
          if (s.state === "ready" && dropped++ < 20) console.error(`side ${s.id}: dropped a line (${parsed.error}, ${line.length} chars) ${logPrefix(line)}`);
          return;
        }
        const f = parsed.frame;
        if (f.kind === "git") {
          const call = s.gits.get(f.g);
          if (!call) return;
          s.gits.delete(f.g);
          clearTimeout(call.timer);
          const stdout = Buffer.from(f.out, "base64");
          if (!f.error) call.ok({ stdout, stderr: f.err });
          else call.fail(Object.assign(new Error(f.error.message), { stderr: f.err, stdout, killed: !!f.error.killed, code: f.error.code, signal: f.error.signal ?? undefined }));
          return;
        }
        if (f.kind === "ready") {
          endSpans(s, false);
          delete s.phase;
          clashed.delete(s.id);
          Object.assign(s, { state: "ready", message: undefined });
          started.add(s.id);
          opts.save?.([...started]);
          resolve();
          routers.forEach((r) => r.attach(s.id));
          changed();
        } else if (f.kind === "push") {
          // A side notifies for its own sessions only (GH-279): not for one another side owns.
          const owner = sessionSide.get(f.push.sessionId);
          if (!owner || owner === s.id) opts.onPush?.(f.push);
        }
        else s.conns.get(f.c)?.(f.m);
      }, opts.maxLineChars ?? MAX_SIDE_LINE_CHARS, () => console.error(`side ${s.id}: dropped a line (too long, more than ${opts.maxLineChars ?? MAX_SIDE_LINE_CHARS} chars)`));
      proc.on("exit", (code) => {
        const wasReady = s.state === "ready";
        // A crashed side logs `claude-ui daemon: uncaughtException: <error>` first; Node's own fatal print ends in frames and a `Node.js vX` trailer.
        const crash = CRASH.exec(partial)?.[1] ?? crashLine;
        const tail = (
          crash ??
          stderr
            .trim()
            .split("\n")
            .filter((l) => l.trim() && !/cannot set terminal process group|no job control|^Node\.js v\d/.test(l))
            .slice(-3)
            .join(" ")
        )
          .trim()
          .slice(0, 300);
        const message =
          setupError ??
          (wasReady
            ? `${s.label} stopped (exit code ${code})${code && tail ? `: ${tail}` : ""}. Retry to start it again.`
            : `${s.label} could not start (exit code ${code})${tail ? `: ${tail}` : ""}.`);
        // Nothing installed and none asked for (setup `never`): the side is as it was before, not failed.
        const notInstalled = !wasReady && setupCode === "not_installed";
        delete s.phase;
        Object.assign(s, notInstalled ? { state: "off", message: undefined } : { state: "error", message }, { proc: undefined, starting: undefined });
        s.conns.clear();
        for (const [gid, c] of s.gits) {
          clearTimeout(c.timer);
          c.fail(new SideGone(`${s.label} stopped`, true));
          s.gits.delete(gid);
        }
        for (const reqId of [...(requestsOf.get(s.id) ?? [])]) forgetRequest(reqId);
        if (!wasReady) reject(new Error(message));
        routers.forEach((r) => r.detach(s.id));
        changed();
      });
      });
    })().finally(() => (endSpans(s), (s.starting = undefined)));
    return s.starting;
  }

  function open(id: string, onMessage: (m: ServerMessage) => void): Conn | undefined {
    const s = sides.get(id);
    if (s?.state !== "ready") return undefined;
    const c = nextConn++;
    s.conns.set(c, onMessage);
    write(s, { c, o: 1 });
    return {
      send: (m) => write(s, { c, m }),
      close: () => {
        s.conns.delete(c);
        write(s, { c, x: 1 });
      },
    };
  }

  const exists = opts.localPathExists ?? ((p: string) => !!opts.posixLocal && existsSync(p));
  /** A local folder, whatever a side says (GH-320): a local dir or a parent of one; a folder inside a local dir that exists on the hub (GH-328); a local cwd, a parent or a sub-folder of one. */
  function localFolder(p: string): boolean {
    return localDirs.some((d) => within(d, p) || (p !== d && within(p, d) && exists(p))) || [...cwdSide].some(([c, s]) => s === LOCAL_SIDE && (within(c, p) || within(p, c)));
  }
  /** Records that side `id` has cwd `p`; refused (false) when `p` is not canonical or is a local folder. */
  function claimCwd(id: string, p: unknown): boolean {
    if (typeof p !== "string" || !canonical(p) || localFolder(p)) return false;
    cwdSide.set(p, id);
    return true;
  }
  /** `p` is local (POSIX hub): side entries that are its parents or sub-folders go back to local. */
  function markLocal(p: unknown) {
    if (!opts.posixLocal || typeof p !== "string" || !p.startsWith("/")) return;
    for (const [c, s] of cwdSide) if (s !== LOCAL_SIDE && (within(c, p) || within(p, c))) cwdSide.delete(c);
    cwdSide.set(p, LOCAL_SIDE);
  }

  /**
   * Owner of each terminal and cwd a side's reply names. Only for a reply to a request the router forwarded to that side
   * (createRouter drops the rest). Sessions are not learned here: the router claims them (GH-279). A cwd counts only from a
   * reply to `project.open` or from the cwd of a session the side owns (GH-320), and never a local folder (claimCwd).
   */
  function learn(id: string, m: ServerMessage, kind: string) {
    if (m.type !== "reply" || !m.result || typeof m.result !== "object") return;
    const r = m.result as { cwd?: unknown; session?: { id?: unknown; cwd?: unknown }; terminal?: { id?: unknown }; terminals?: { id?: unknown }[] };
    if (typeof r.session?.id === "string" && sessionSide.get(r.session.id) === id) claimCwd(id, r.session.cwd);
    if (kind === "project.open") claimCwd(id, r.cwd);
    if (typeof r.terminal?.id === "string") terminalSide.set(r.terminal.id, id);
    if (Array.isArray(r.terminals)) r.terminals.forEach((t) => typeof t?.id === "string" && terminalSide.set(t.id, id));
  }

  /**
   * Side of a path: a Windows path is local; a POSIX path belongs to the side of the longest known cwd containing it (on a
   * POSIX hub the local list's cwds count too: "local"), else to the only ready side. ponytail: the same POSIX path in two
   * sides goes to the one learned last, and a bind mount at the same path on the host and in a container goes to local on a
   * POSIX hub; carry the side in every request if that matters.
   */
  function pathSide(p: unknown): string | undefined {
    if (typeof p !== "string" || !p.startsWith("/")) return undefined;
    let best: [string, string] | undefined;
    for (const [cwd, id] of cwdSide) if (within(p, cwd) && (!best || cwd.length > best[0].length)) best = [cwd, id];
    if (best || opts.posixLocal) return best?.[1];
    const ready = [...sides.values()].filter((s) => s.state === "ready");
    return ready.length === 1 ? ready[0]!.id : undefined;
  }

  /** One check per side at a time: a second request gets the running one's answer. */
  const checking = new Map<string, Promise<SideCheck>>();
  /**
   * `side.check`: read-only. A ready side answers `running` and a starting one `starting` without running anything; otherwise
   * `opts.check` looks at it (never rejects; no answer in `checkMs`: blocked `unreachable`).
   */
  function check(id: string): Promise<SideCheck> {
    const s = sides.get(id)!;
    const key = opts.key?.() ?? "";
    const facts = (running: boolean): SideCheck["facts"] => ({ reachable: true, running, installed: "current" });
    if (s.state === "ready") return Promise.resolve({ verdict: "running", key, facts: facts(true) });
    if (s.state === "starting") return Promise.resolve({ verdict: "starting", key, facts: facts(true), ...(s.phase && { phase: s.phase }) });
    const running = checking.get(id);
    if (running) return running;
    const docker = isDocker(id);
    const ms = opts.checkMs ?? 30_000;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<SideCheck>((resolve) => (timer = setTimeout(() => resolve(blockedCheck(key, s.label, "unreachable", { docker, detail: "no answer in time" })), ms)));
    const asked = (opts.check ? opts.check(id) : Promise.resolve(blockedCheck(key, s.label, "check_failed", { docker, detail: "this version of Claude UI cannot check it" }))).catch((e) => blockedCheck(key, s.label, "check_failed", { docker, detail: (e as Error).message }));
    const p = Promise.race([asked, timeout]).finally(() => (clearTimeout(timer), checking.delete(id)));
    checking.set(id, p);
    return p;
  }

  for (const id of started) if (sides.has(id)) autoStart(id);

  let lastDiscover = 0;
  let discovering: Promise<void> | undefined;
  /** Discovered sides (Docker containers): they come and go with their containers. */
  const dynamic = new Set<string>();
  /** Lists the dynamic sides again (throttled, one at a time): new ones join as off, vanished ones leave unless started or failed. */
  function refresh(): Promise<void> {
    if (!opts.discover) return Promise.resolve();
    if (discovering) return discovering;
    if (Date.now() - lastDiscover < (opts.discoverMs ?? 5000)) return Promise.resolve();
    lastDiscover = Date.now();
    const before = opts.dockerState?.();
    return (discovering = opts
      .discover()
      .then(
        (found) => {
          // The Docker engine state (down, empty, ok) is part of the list: a change alone sends sessions.changed, so an open dialog updates its hint.
          let diff = opts.dockerState?.() !== before;
          const ids = new Set(found.map((t) => t.id));
          for (const t of found)
            if (!sides.has(t.id)) {
              sides.set(t.id, { ...t, state: "off", conns: new Map(), gits: new Map() });
              dynamic.add(t.id);
              diff = true;
            }
          for (const id of dynamic)
            if (!ids.has(id) && sides.get(id)?.state === "off") {
              sides.delete(id);
              dynamic.delete(id);
              diff = true;
            }
          if (diff) changed();
          found.forEach((t) => autoStart(t.id));
        },
        () => {},
      )
      .finally(() => (discovering = undefined)));
  }

  return {
    /** Every side, local first. */
    list: (): SideInfo[] => [{ id: LOCAL_SIDE, label: opts.localLabel ?? "Windows", state: "ready" }, ...[...sides.values()].map(({ id, label, state, message, phase }) => ({ id, label, state, ...(message && { message }), ...(phase && state === "starting" && { phase }) }))],
    docker: () => opts.dockerState?.(),
    has: (id: string) => sides.has(id),
    check,
    ready: () => [...sides.values()].filter((s) => s.state === "ready").map((s) => s.id),
    /** The ready `wsl:<x>` side whose distro `<x>` equals `distro` (case-insensitive). */
    wslReady: (distro: string) => [...sides.values()].find((s) => s.state === "ready" && s.id.toLowerCase() === `wsl:${distro}`.toLowerCase())?.id,
    /** Runs git in a ready side; rejects `SideGone` when it is not ready or ends meanwhile. */
    git(id: string, o: GitRunOptions): Promise<GitRunOutput> {
      const s = sides.get(id);
      if (s?.state !== "ready" || !s.proc) return Promise.reject(new SideGone(`${id} is not running`));
      const gid = ++nextGit;
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => {
          s.gits.delete(gid);
          fail(Object.assign(new Error("git timed out"), { killed: true, stderr: "", stdout: Buffer.alloc(0) }));
        }, (o.timeout ?? 30_000) + 10_000);
        timer.unref();
        s.gits.set(gid, { ok, fail, timer });
        write(s, { g: gid, git: { cwd: o.cwd, args: o.args, env: o.env, input: o.input, timeout: o.timeout, maxBuffer: o.maxBuffer } });
      });
    },
    start,
    refresh,
    posixLocal: !!opts.posixLocal,
    open,
    learn,
    requestSide,
    noteRequest,
    forgetRequest,
    clash,
    contest,
    contested,
    sessionSide,
    terminalSide,
    cwdSide,
    claimCwd,
    markLocal,
    pathSide,
    onChange(l: () => void) {
      changeListeners.add(l);
      return () => void changeListeners.delete(l);
    },
    addRouter: (r: Router) => void routers.add(r),
    removeRouter: (r: Router) => void routers.delete(r),
    close: () => sides.forEach((s) => s.proc?.kill()),
  };
}

export type Sides = ReturnType<typeof createSides>;
type Router = { attach(id: string): void; detach(id: string): void };

/** The local daemon's answer to one message: its reply or error. */
type LocalCall = (msg: ClientMessage) => Promise<ServerMessage>;

type ListLike = { sessions: { id: string; cwd: string; lastActivity: number }[]; projects: string[]; recentProjects: { cwd: string; lastActivity: number }[]; worktrees?: Record<string, { path: string }[]> };

/**
 * Per browser connection: forwards each request to its side and merges the answers that span sides. `local` handles a
 * message in this daemon and sends to the browser; `localCall` returns the local answer instead. `isLocalSession`: this
 * daemon has the session (live or as a transcript inside its roots).
 */
export function createRouter(opts: {
  sides: Sides;
  send: (m: ServerMessage) => void;
  local: (msg: ClientMessage) => Promise<void>;
  localCall: LocalCall;
  isLocalSession: (id: string) => Promise<boolean>;
  /** fs.media of a side's path: the hub serves it (server.ts sideMedia); `call` asks that side. Absent: refused with side_unsupported. */
  /** Longest wait for one media piece from a side (default MEDIA_PIECE_TIMEOUT_MS). */
  mediaTimeoutMs?: number;
  /** Longest wait for a side's list in the lookup of an unlisted session ID (default LOOKUP_TIMEOUT_MS); no answer: the side lists nothing. */
  lookupTimeoutMs?: number;
  media?: (id: string, msg: Extract<ClientMessage, { type: "fs.media" }>, call: (m: ClientMessage) => Promise<ServerMessage>) => Promise<ServerMessage>;
}) {
  const { sides, send } = opts;
  const conns = new Map<string, Conn>();
  /** Answers of side requests the router asked itself (merged lists, fan-outs), by internal reqId. */
  const own = new Map<string, (m: ServerMessage) => void>();
  /** Calls waiting for a side's answer, by their hub reqId: detach settles them. */
  const pending = new Map<string, { id: string; settle: (m: ServerMessage) => void; type: string }>();
  let nextReq = 1;
  /** Requests forwarded to each side, by the browser's reqId: only a reply or error to one of these is accepted from that side (GH-279). */
  const forwarded = new Map<string, Map<string, string>>();
  const { noteRequest, requestSide, forgetRequest } = sides;
  /**
   * A side owns a session ID only when it was told so by a reply to a request it was sent (or by its own /clear heir): never an
   * ID the local daemon has or another side owns. Returns whether `id` now belongs to `side`.
   */
  async function claimSession(side: string, sessionId: string): Promise<boolean> {
    const owner = sides.sessionSide.get(sessionId);
    if (owner) return owner === side;
    if (sides.contested.has(sessionId)) return false;
    if (await opts.isLocalSession(sessionId)) return sides.clash(side, sessionId), false;
    // Another claim may have won while the local check ran.
    const now = sides.sessionSide.get(sessionId);
    if (now) return now === side;
    if (sides.contested.has(sessionId)) return false;
    sides.sessionSide.set(sessionId, side);
    return true;
  }
  const noteReply = async (id: string, m: Extract<ServerMessage, { type: "reply" }>, kind: string): Promise<boolean> => {
    const r = m.result as { session?: { id?: unknown }; snapshot?: { heads?: { part?: unknown }[]; page?: { parts?: unknown[] }; aux?: { part?: unknown }[] }; page?: { parts?: unknown[] } } | null;
    if (!r || typeof r !== "object") return true;
    if (typeof r.session?.id === "string" && !(await claimSession(id, r.session.id))) return false;
    sides.learn(id, m, kind);
    const parts = [...(r.snapshot?.heads?.map((h) => h.part) ?? []), ...(r.snapshot?.page?.parts ?? []), ...(r.snapshot?.aux?.map((a) => a.part) ?? []), ...(r.page?.parts ?? [])];
    for (const p of parts) noteRequest(id, p as never);
    return true;
  };
  const sideConflict = (reqId: string): ServerMessage => ({ type: "error", reqId, code: "side_conflict", message: "more than one side has this session" });
  const conflict = (m: ServerMessage & { reqId?: string }): ServerMessage => ({ type: "error", reqId: m.reqId, code: "side_conflict", message: "the side named a session it does not own" });
  /** One message of side `id`, after the ones before it (a claim may wait for the local check). */
  const onSide = async (id: string, m: ServerMessage) => {
    if (m.type === "reply" || m.type === "error" || m.type === "sessions.search.result") {
      const reqId = m.reqId;
      let kind = "";
      if (reqId && own.has(reqId)) {
        // A hub request: only the side it was sent to answers it.
        if (pending.get(reqId)?.id !== id) return;
        if (m.type === "reply" && !(await noteReply(id, m, pending.get(reqId)!.type))) return own.get(reqId)!(conflict(m)), own.delete(reqId);
        own.get(reqId)?.(m);
        own.delete(reqId);
        return;
      }
      // An error may carry no reqId (a message the side could not parse); everything else answers a forwarded request.
      if (!(m.type === "error" && !reqId)) {
        const f = forwarded.get(id);
        if (!reqId || !f?.has(reqId)) return;
        kind = f.get(reqId)!;
        // A search streams results before its reply.
        if (m.type !== "sessions.search.result") f.delete(reqId);
      }
      if (m.type === "reply" && !(await noteReply(id, m, kind))) return send(conflict(m));
      return send(m);
    }
    if (m.type === "event") {
      const owner = sides.sessionSide.get(m.sessionId);
      if (owner !== id) return;
      // /clear: the owner hands the live query to a new session, announced on the old one.
      if (m.part.type === "session_cleared" && !(await claimSession(id, m.part.sessionId))) return;
      noteRequest(id, m.part as never);
      return send(m);
    }
    // Plan usage is the local account's; a side's would overwrite it.
    if (m.type === "plan_usage") return;
    // A side deletes its own sessions from the list only.
    if (m.type === "sessions.changed" && m.deleted !== undefined && sides.sessionSide.get(m.deleted) !== id) return send({ type: "sessions.changed" });
    send(m);
  };
  const router: Router = {
    attach(id) {
      if (conns.has(id)) return;
      // Messages of one side are handled in order.
      let tail: Promise<unknown> = Promise.resolve();
      const c = sides.open(id, (m) => void (tail = tail.then(() => onSide(id, m)).catch((e) => console.error(`side ${id}: ${(e as Error).message}`))));
      if (!c) return;
      forwarded.set(id, new Map());
      conns.set(id, c);
      void syncSettings(id);
      // Its projects and sessions join the list.
      send({ type: "sessions.changed" });
    },
    detach(id) {
      if (!conns.delete(id)) return;
      forwarded.delete(id);
      // A call the side can no longer answer ends with side_not_ready (a GET /media waiting for a piece ends).
      for (const [reqId, pend] of pending) if (pend.id === id) pend.settle({ type: "error", reqId, code: "side_not_ready", message: `${id} stopped` });
      send({ type: "sessions.changed" });
    },
  };

  /** A side's answer to `msg`; an error answer when the side is gone. */
  const sideCall = (id: string, msg: ClientMessage, timeoutMs?: number) =>
    new Promise<ServerMessage>((resolve) => {
      const c = conns.get(id);
      if (!c) return resolve({ type: "error", reqId: msg.reqId, code: "side_not_ready", message: `${id} is not running` });
      const reqId = `hub:${nextReq++}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (m: ServerMessage) => {
        clearTimeout(timer);
        own.delete(reqId);
        pending.delete(reqId);
        resolve({ ...m, reqId: msg.reqId } as ServerMessage);
      };
      own.set(reqId, settle);
      pending.set(reqId, { id, settle, type: msg.type });
      if (timeoutMs) timer = setTimeout(() => settle({ type: "error", reqId, code: "side_timeout", message: `${id} did not answer in ${timeoutMs} ms` }), timeoutMs);
      c.send({ ...msg, reqId } as ClientMessage);
    });
  const call = (id: string, msg: ClientMessage) => (id === LOCAL_SIDE ? opts.localCall(msg) : sideCall(id, msg));
  const forward = (id: string, msg: ClientMessage) => {
    const c = conns.get(id);
    if (!c) return send({ type: "error", reqId: msg.reqId, code: "side_not_ready", message: `${sides.list().find((s) => s.id === id)?.label ?? id} is not running. Open it in the project picker to start it.` });
    forwarded.get(id)?.set(msg.reqId, msg.type);
    c.send(msg);
  };
  const all = () => [LOCAL_SIDE, ...conns.keys()];
  sides.addRouter(router);
  sides.ready().forEach((id) => router.attach(id));

  /** The hub's app settings on a side: a coordinator there gets the same orchestration settings. */
  async function syncSettings(id: string, settings?: Settings) {
    if (!settings) {
      const r = await opts.localCall({ type: "settings.get", reqId: "" } as ClientMessage);
      if (r.type !== "reply") return;
      settings = (r.result as SettingsResult).settings;
    }
    await sideCall(id, { type: "settings.set", patch: settings, reqId: "" } as ClientMessage);
  }

  /**
   * Session rows of each side's list that the side may own (GH-279, GH-321): an unowned ID two or more sides list in one round is
   * contested; local and foreign IDs are left out. A side that fails its list leaves it out; its state shows in `sides`.
   */
  async function claimListed(answers: (readonly [string, ServerMessage])[], localIds: Set<string>): Promise<Map<string, ListLike>> {
    const valid = answers.filter((x): x is readonly [string, Extract<ServerMessage, { type: "reply" }>] => x[1].type === "reply" && Array.isArray((x[1].result as ListLike | null)?.sessions));
    const listedBy = new Map<string, string[]>();
    for (const [id, a] of valid) for (const sid of new Set((a.result as ListLike).sessions.map((s) => s.id))) if (!localIds.has(sid) && !sides.sessionSide.has(sid)) listedBy.set(sid, [...(listedBy.get(sid) ?? []), id]);
    // A local ID is never contested (a shared ~/.claude): each side's row is left out as a clash below (GH-328).
    for (const [sid, ids] of listedBy) if (ids.length > 1 && !(await opts.isLocalSession(sid))) sides.contest(sid, ids);
    const out = new Map<string, ListLike>();
    for (const [id, a] of valid) {
      const r = a.result as ListLike;
      // A side lists its own sessions only: not an ID the local daemon lists or has, nor one of another side.
      const owned = await Promise.all(r.sessions.map(async (s) => (localIds.has(s.id) ? (sides.clash(id, s.id), false) : await claimSession(id, s.id))));
      r.sessions = r.sessions.filter((_, i) => owned[i]);
      out.set(id, r);
    }
    return out;
  }
  /** Session IDs side `id` has: `session.ids`; an older side without it: the IDs of its list (added projects only). None on error or timeout. */
  async function idsOf(id: string): Promise<Set<string>> {
    const t = opts.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS;
    const a = await sideCall(id, { type: "session.ids", reqId: "" } as ClientMessage, t);
    const r = a.type === "reply" ? (a.result as { ids?: unknown } | null) : undefined;
    if (Array.isArray(r?.ids)) return new Set(r.ids.filter((x): x is string => typeof x === "string"));
    if (a.type !== "error" || a.code !== "unknown_type") return new Set();
    const l = await sideCall(id, { type: "session.list", reqId: "" } as ClientMessage, t);
    const rows = l.type === "reply" ? (l.result as ListLike | null)?.sessions : undefined;
    return new Set(Array.isArray(rows) ? rows.flatMap((x) => (typeof x?.id === "string" ? [x.id] : [])) : []);
  }
  let round: Promise<Map<string, Set<string>>> | undefined;
  /** Every side's session IDs; one round at a time, shared by concurrent lookups. */
  const idsRound = () => (round ??= Promise.all([...conns.keys()].map(async (id) => [id, await idsOf(id)] as const)).then((e) => new Map(e)).finally(() => (round = undefined)));
  /** Finds the side of an unlisted session ID without sending it to any side (GH-328): one side having it gets it, two or more contest it. */
  async function lookUp(sessionId: string) {
    const by = await idsRound();
    if (sides.sessionSide.has(sessionId) || sides.contested.has(sessionId)) return;
    const having = [...by].filter(([, ids]) => ids.has(sessionId)).map(([id]) => id);
    if (having.length > 1) sides.contest(sessionId, having);
    else if (having.length === 1) await claimSession(having[0]!, sessionId);
  }

  /** The side a message goes to. */
  async function target(msg: ClientMessage & Record<string, unknown>): Promise<string | null> {
    if (typeof msg.side === "string" && (msg.side === LOCAL_SIDE || sides.has(msg.side))) return msg.side;
    if (typeof msg.sessionId === "string") {
      const known = sides.sessionSide.get(msg.sessionId);
      if (known) return known;
      if (sides.contested.has(msg.sessionId) && !(await opts.isLocalSession(msg.sessionId))) return null;
      if (conns.size && !(await opts.isLocalSession(msg.sessionId))) {
        // A link or notification to a side session this connection has not listed yet: ask every side for its session IDs, never send the ID to one (GH-328).
        await lookUp(msg.sessionId);
        const owner = sides.sessionSide.get(msg.sessionId);
        if (owner) return owner;
        if (sides.contested.has(msg.sessionId)) return null;
      }
      return LOCAL_SIDE;
    }
    if (typeof msg.terminalId === "string") return sides.terminalSide.get(msg.terminalId) ?? LOCAL_SIDE;
    return sides.pathSide(msg.cwd ?? msg.path) ?? LOCAL_SIDE;
  }

  async function mergedList(msg: ClientMessage): Promise<ServerMessage> {
    void sides.refresh();
    const answers = await Promise.all(all().map(async (id) => [id, await call(id, msg)] as const));
    const local = answers[0]![1];
    if (local.type !== "reply") return local;
    const merged = { ...(local.result as ListLike & object) } as ListLike & Record<string, unknown>;
    const cwdSides: Record<string, string> = {};
    const docker = sides.docker();
    // A POSIX hub: local cwds are marked first, so a side never claims one of them or a parent or sub-folder (GH-320).
    if (sides.posixLocal) {
      const l = local.result as ListLike;
      for (const p of [...l.sessions.map((s) => s.cwd), ...l.projects, ...l.recentProjects.map((x) => x.cwd), ...Object.values(l.worktrees ?? {}).flatMap((w) => w.map((x) => x.path))]) sides.markLocal(p);
    }
    const lists = await claimListed(answers.slice(1), new Set((local.result as ListLike).sessions.map((s) => s.id)));
    for (const [id, r] of lists) {
      for (const p of [...r.sessions.map((s) => s.cwd), ...r.projects, ...r.recentProjects.map((x) => x.cwd), ...Object.values(r.worktrees ?? {}).flatMap((w) => w.map((x) => x.path))]) if (sides.claimCwd(id, p)) cwdSides[p] = id;
      merged.worktrees = { ...merged.worktrees, ...r.worktrees };
      merged.sessions = [...merged.sessions, ...r.sessions];
      merged.projects = [...merged.projects, ...r.projects];
      merged.recentProjects = [...merged.recentProjects, ...r.recentProjects];
    }
    // Newest activity first across sides, as each side orders its own.
    const newest = new Map<string, number>();
    for (const s of merged.sessions) newest.set(s.cwd, Math.max(newest.get(s.cwd) ?? 0, s.lastActivity));
    const order = merged.projects.map((p, i) => [p, i] as const);
    merged.projects = order.sort((a, b) => (newest.get(b[0]) ?? -1) - (newest.get(a[0]) ?? -1) || a[1] - b[1]).map(([p]) => p);
    merged.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    merged.recentProjects.sort((a, b) => b.lastActivity - a.lastActivity);
    return { type: "reply", reqId: msg.reqId, result: { ...merged, sides: sides.list(), ...(docker && { docker }), cwdSides } };
  }

  async function handle(msg: ClientMessage & Record<string, unknown>) {
    switch (msg.type) {
      case "session.list":
        return send(await mergedList(msg));
      case "side.start": {
        if (typeof msg.side !== "string" || !sides.has(msg.side)) return send({ type: "error", reqId: msg.reqId, code: "unknown_side", message: `unknown side ${String(msg.side)}` });
        if (msg.setup !== undefined && msg.setup !== "never" && msg.setup !== "needed" && msg.setup !== "force") return send({ type: "error", reqId: msg.reqId, code: "bad_request", message: "setup must be never, needed or force" });
        try {
          await sides.start(msg.side, msg.setup);
          router.attach(msg.side);
          return send({ type: "reply", reqId: msg.reqId, result: {} });
        } catch (e) {
          return send({ type: "error", reqId: msg.reqId, code: "side_failed", message: (e as Error).message });
        }
      }
      case "side.check": {
        // Read-only and the hub's own: never forwarded to a side.
        if (typeof msg.side !== "string" || !sides.has(msg.side)) return send({ type: "error", reqId: msg.reqId, code: "unknown_side", message: `unknown side ${String(msg.side)}` });
        return send({ type: "reply", reqId: msg.reqId, result: await sides.check(msg.side) });
      }
      case "settings.set": {
        const r = await opts.localCall(msg);
        send(r);
        if (r.type === "reply") for (const id of conns.keys()) void syncSettings(id, (r.result as SettingsResult).settings);
        return;
      }
      case "permission.respond":
      case "question.respond": {
        // Only the side that raised the request gets the answer; a request no side raised is the local daemon's.
        const owner = typeof msg.requestId === "string" ? requestSide.get(msg.requestId) : undefined;
        const answer = await call(owner && conns.has(owner) ? owner : LOCAL_SIDE, msg);
        if (answer.type === "reply" && typeof msg.requestId === "string") forgetRequest(msg.requestId);
        return send(answer);
      }
      case "push.focus":
        // Each side suppresses pushes for the sessions shown here that it owns, and learns no other ID.
        for (const id of conns.keys()) {
          const mine = (x: unknown) => typeof x === "string" && sides.sessionSide.get(x) === id;
          const { sessionId, covered, ...rest } = msg as { sessionId?: unknown; covered?: unknown };
          void sideCall(id, { ...rest, ...(mine(sessionId) && { sessionId }), ...(Array.isArray(covered) && { covered: covered.filter(mine) }) } as ClientMessage);
        }
        return opts.local(msg);
      case "fs.watch": {
        if (!Array.isArray(msg.paths)) return opts.local(msg);
        const by = new Map<string, string[]>(all().map((id) => [id, []]));
        for (const p of msg.paths as unknown[]) by.get(sides.pathSide(p) ?? LOCAL_SIDE)?.push(p as string);
        const answers = await Promise.all([...by].map(([id, paths]) => call(id, { ...msg, paths } as ClientMessage)));
        const watching = answers.flatMap((a) => (a.type === "reply" ? ((a.result as { watching?: string[] }).watching ?? []) : []));
        return send({ type: "reply", reqId: msg.reqId, result: { watching } });
      }
      case "fs.media": {
        const id = await target(msg);
        if (id === null) return send(sideConflict(msg.reqId));
        if (id === LOCAL_SIDE) return opts.local(msg);
        if (!opts.media) return send({ type: "error", reqId: msg.reqId, code: "side_unsupported", message: `Preview is not available for files in ${id.startsWith("docker:") ? "Docker" : "WSL"}` });
        const { side: _side, ...rest } = msg;
        return send(await opts.media(id, rest as Extract<ClientMessage, { type: "fs.media" }>, (m) => sideCall(id, m, opts.mediaTimeoutMs ?? MEDIA_PIECE_TIMEOUT_MS)));
      }
      case "artifact.preview": {
        const id = await target(msg);
        if (id === null) return send(sideConflict(msg.reqId));
        if (id === LOCAL_SIDE) return opts.local(msg);
        return send({ type: "error", reqId: msg.reqId, code: "side_unsupported", message: `Preview is not available for sessions in ${id.startsWith("docker:") ? "Docker" : "WSL"}` });
      }
      default: {
        const id = await target(msg);
        if (id === null) return send(sideConflict(msg.reqId));
        if (id === LOCAL_SIDE) {
          // The folder the local daemon opened is local at once, before the next list (GH-320).
          if (msg.type === "project.open" && sides.posixLocal) {
            const r = await opts.localCall(msg);
            if (r.type === "reply") sides.markLocal((r.result as { cwd?: unknown } | null)?.cwd);
            return send(r);
          }
          return opts.local(msg);
        }
        const { side: _side, ...rest } = msg;
        return forward(id, rest as ClientMessage);
      }
    }
  }

  return {
    handle,
    close() {
      sides.removeRouter(router);
      // Calls waiting for a side end now (not after their timeout).
      for (const [reqId, pend] of pending) pend.settle({ type: "error", reqId, code: "side_not_ready", message: "connection closed" });
      conns.forEach((c) => c.close());
      conns.clear();
      own.clear();
    },
  };
}

/** A WebSocket stand-in for one virtual connection of a side: what the daemon's connection handler uses. */
export class SideSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  constructor(private out: (data: string) => void, private backlog: () => number) {
    super();
  }
  get bufferedAmount() {
    return this.backlog();
  }
  send(data: string) {
    if (this.readyState === this.OPEN) this.out(data);
  }
  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit("close");
  }
  /** The daemon's keep-alive ping: the pipe to the hub is the liveness signal (the side ends when it goes away), so answer at once. */
  ping() {
    queueMicrotask(() => {
      if (this.readyState === this.OPEN) this.emit("pong");
    });
  }
  terminate() {
    this.close();
  }
}

/**
 * Side mode (`claude-ui --side`, run by the hub inside a distro): serves virtual connections from `input` through `accept`
 * (the daemon's connection handler) and writes their messages to `output`. Ends the process when the hub goes away.
 */
export function runSide(opts: { input: Readable; output: Writable; accept: (ws: SideSocket) => void; onEnd?: () => void; git?: GitRunner }) {
  const sockets = new Map<number, SideSocket>();
  const write = (s: string) => opts.output.write(s + "\n");
  lines(opts.input, (line) => {
    let f: { c?: number; o?: unknown; m?: unknown; x?: unknown; g?: number; git?: GitRunOptions };
    try {
      f = JSON.parse(line);
    } catch {
      return;
    }
    if (!f) return;
    if (typeof f.g === "number" && f.git) {
      const g = f.g;
      const answer = (a: object) => write(JSON.stringify({ g, ...a }));
      if (!opts.git) return answer({ out: "", err: "", error: { message: "no git" } });
      // The side's own GIT_* (a login profile may set GIT_DIR, GIT_WORK_TREE ...) is dropped, whatever it is: git gets the hub's env only,
      // like the wsl.exe path (fixed list, `wslExeEnv`). The hub sends every GIT_* variable it wants (the repository pin included).
      opts.git({ ...f.git, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), ...f.git.env } }).then(
        (r) => answer({ out: r.stdout.toString("base64"), err: r.stderr }),
        (e: Error & { stdout?: Buffer; stderr?: string; code?: string | number; killed?: boolean; signal?: string }) => answer({ out: (e.stdout ?? Buffer.alloc(0)).toString("base64"), err: e.stderr ?? "", error: { message: e.message, code: e.code, killed: !!e.killed, signal: e.signal } }),
      );
      return;
    }
    if (typeof f.c !== "number") return;
    const c = f.c;
    if (f.o) {
      const ws = new SideSocket(
        (data) => write(`{"c":${c},"m":${data}}`),
        () => (opts.output as Writable & { writableLength?: number }).writableLength ?? 0,
      );
      sockets.set(c, ws);
      opts.accept(ws);
    } else if (f.x) {
      sockets.get(c)?.close();
      sockets.delete(c);
    } else if (f.m !== undefined) sockets.get(c)?.emit("message", JSON.stringify(f.m));
  });
  opts.input.on("end", () => {
    sockets.forEach((s) => s.close());
    opts.onEnd?.();
  });
  write(JSON.stringify({ ready: true }));
  return {
    push: (p: PushPayload) => write(JSON.stringify({ push: p })),
  };
}
