// WSL distros (Windows) and running Linux Docker containers (any OS) (docs/spec.md "Sides"): the daemon (hub) also serves each
// of them through a side: the same daemon run inside the distro or container with `--side`, without HTTP, speaking the wire protocol over its stdio. The hub routes each
// browser request to the side that owns its session, terminal or path; one URL, one pairing, one page for every side.
// Frames are JSON lines. hub -> side: {c, o} opens virtual connection c, {c, m} a client message, {c, x} closes it.
// side -> hub: {ready} once listening, {c, m} a server message, {push} a Web Push payload. Other stdout lines are ignored.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { LOCAL_SIDE, type ClientMessage, type PushPayload, type ServerMessage, type SettingsResult, type Settings, type SideCheck, type SideCheckFacts, type SideCheckReason, type DockerState, type SideInfo, type SidePhase, type SideSetup } from "@claude-ui/protocol";
import type { Exec } from "./docker-side.ts";

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

/** Calls `onLine` for each complete line of `stream`. */
function lines(stream: Readable, onLine: (line: string) => void) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    const parts = (rest + d).split("\n");
    rest = parts.pop()!;
    parts.forEach(onLine);
  });
}

type Side = SideInfo & { proc?: SideProcess; starting?: Promise<void>; conns: Map<number, (m: ServerMessage) => void> };

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
}) {
  const sides = new Map<string, Side>(opts.targets.map((t) => [t.id, { ...t, state: "off", conns: new Map() }]));
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
  const write = (s: Side, frame: object) => {
    try {
      s.proc?.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // Exited: its exit handler resets it.
    }
  };

  const setPhase = (s: Side, phase: SidePhase | undefined) => {
    if (s.phase === phase || (phase && s.state !== "starting")) return;
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
    s.starting = (async () => {
      let proc: SideProcess;
      try {
        proc = await opts.spawn(s.id, { setup, phase: (p) => setPhase(s, p) });
      } catch (e) {
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
      lines(proc.stdout, (line) => {
        const phase = /^CLAUDE_UI_PHASE (installing|starting)$/.exec(line.trim());
        if (phase) return setPhase(s, phase[1] as SidePhase);
        const setup = /^CLAUDE_UI_SETUP (\S+) ?(.*)$/.exec(line.trim());
        if (setup) return void ((setupCode = setup[1]), (setupError = setupMessage(setup[1]!, setup[2]!, s.label, isDocker(s.id))));
        let f: { ready?: boolean; c?: number; m?: ServerMessage; push?: PushPayload };
        try {
          f = JSON.parse(line);
        } catch {
          // Shell start-up output (motd, .bashrc).
          return;
        }
        if (f.ready) {
          delete s.phase;
          Object.assign(s, { state: "ready", message: undefined });
          started.add(s.id);
          opts.save?.([...started]);
          resolve();
          routers.forEach((r) => r.attach(s.id));
          changed();
        } else if (f.push) opts.onPush?.(f.push);
        else if (f.c !== undefined && f.m) s.conns.get(f.c)?.(f.m);
      });
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
        if (!wasReady) reject(new Error(message));
        routers.forEach((r) => r.detach(s.id));
        changed();
      });
      });
    })().finally(() => (s.starting = undefined));
    return s.starting;
  }

  function open(id: string, onMessage: (m: ServerMessage) => void): Conn | undefined {
    const s = sides.get(id);
    if (s?.state !== "ready") return undefined;
    const c = nextConn++;
    s.conns.set(c, (m) => {
      learn(id, m);
      onMessage(m);
    });
    write(s, { c, o: 1 });
    return {
      send: (m) => write(s, { c, m }),
      close: () => {
        s.conns.delete(c);
        write(s, { c, x: 1 });
      },
    };
  }

  /** Owner of each session and terminal a side's messages name. */
  function learn(id: string, m: ServerMessage) {
    if (m.type === "event") sessionSide.set(m.sessionId, id);
    if (m.type !== "reply" || !m.result || typeof m.result !== "object") return;
    const r = m.result as { cwd?: unknown; session?: { id?: unknown; cwd?: unknown }; terminal?: { id?: unknown }; terminals?: { id?: unknown }[] };
    if (typeof r.session?.id === "string") sessionSide.set(r.session.id, id);
    // A local cwd (POSIX hub) keeps its routing: a container cannot take over a host path.
    const claim = (cwd: string) => cwdSide.get(cwd) !== LOCAL_SIDE && cwdSide.set(cwd, id);
    if (typeof r.session?.cwd === "string") claim(r.session.cwd);
    // project.open
    if (typeof r.cwd === "string") claim(r.cwd);
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
    for (const [cwd, id] of cwdSide) if ((p === cwd || p.startsWith(cwd.endsWith("/") ? cwd : cwd + "/")) && (!best || cwd.length > best[0].length)) best = [cwd, id];
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
              sides.set(t.id, { ...t, state: "off", conns: new Map() });
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
    start,
    refresh,
    posixLocal: !!opts.posixLocal,
    open,
    sessionSide,
    terminalSide,
    cwdSide,
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
}) {
  const { sides, send } = opts;
  const conns = new Map<string, Conn>();
  /** Answers of side requests the router asked itself (merged lists, fan-outs), by internal reqId. */
  const own = new Map<string, (m: ServerMessage) => void>();
  let nextReq = 1;
  const onSide = (m: ServerMessage) => {
    if ((m.type === "reply" || m.type === "error") && m.reqId && own.has(m.reqId)) {
      own.get(m.reqId)!(m);
      own.delete(m.reqId);
      return;
    }
    // Plan usage is the local account's; a side's would overwrite it.
    if (m.type === "plan_usage") return;
    send(m);
  };
  const router: Router = {
    attach(id) {
      if (conns.has(id)) return;
      const c = sides.open(id, onSide);
      if (!c) return;
      conns.set(id, c);
      void syncSettings(id);
      // Its projects and sessions join the list.
      send({ type: "sessions.changed" });
    },
    detach(id) {
      if (!conns.delete(id)) return;
      send({ type: "sessions.changed" });
    },
  };

  /** A side's answer to `msg`; an error answer when the side is gone. */
  const sideCall = (id: string, msg: ClientMessage) =>
    new Promise<ServerMessage>((resolve) => {
      const c = conns.get(id);
      if (!c) return resolve({ type: "error", reqId: msg.reqId, code: "side_not_ready", message: `${id} is not running` });
      const reqId = `hub:${nextReq++}`;
      own.set(reqId, (m) => resolve({ ...m, reqId: msg.reqId } as ServerMessage));
      c.send({ ...msg, reqId } as ClientMessage);
    });
  const call = (id: string, msg: ClientMessage) => (id === LOCAL_SIDE ? opts.localCall(msg) : sideCall(id, msg));
  const forward = (id: string, msg: ClientMessage) => {
    const c = conns.get(id);
    if (!c) return send({ type: "error", reqId: msg.reqId, code: "side_not_ready", message: `${sides.list().find((s) => s.id === id)?.label ?? id} is not running. Open it in the project picker to start it.` });
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

  /** The side a message goes to. */
  async function target(msg: ClientMessage & Record<string, unknown>): Promise<string> {
    if (typeof msg.side === "string" && (msg.side === LOCAL_SIDE || sides.has(msg.side))) return msg.side;
    if (typeof msg.sessionId === "string") {
      const known = sides.sessionSide.get(msg.sessionId);
      if (known) return known;
      if (conns.size && !(await opts.isLocalSession(msg.sessionId))) {
        // A link or notification to a side session this connection has not listed yet: ask each side.
        for (const id of conns.keys()) {
          const r = await sideCall(id, { type: "session.subscribe", sessionId: msg.sessionId, sinceSeq: Number.MAX_SAFE_INTEGER, background: true, reqId: "" } as ClientMessage);
          if (r.type === "reply") return sides.sessionSide.set(msg.sessionId, id), id;
        }
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
    for (const [id, a] of answers.slice(1)) {
      // A side that fails its list leaves it out; its state shows in `sides`.
      if (a.type !== "reply") continue;
      const r = a.result as ListLike;
      for (const s of r.sessions) sides.sessionSide.set(s.id, id), (cwdSides[s.cwd] = id);
      for (const p of [...r.projects, ...r.recentProjects.map((x) => x.cwd), ...Object.values(r.worktrees ?? {}).flatMap((w) => w.map((x) => x.path))]) cwdSides[p] = id;
      merged.worktrees = { ...merged.worktrees, ...r.worktrees };
      merged.sessions = [...merged.sessions, ...r.sessions];
      merged.projects = [...merged.projects, ...r.projects];
      merged.recentProjects = [...merged.recentProjects, ...r.recentProjects];
    }
    for (const [cwd, id] of Object.entries(cwdSides)) sides.cwdSide.set(cwd, id);
    // A POSIX hub: local cwds count in the longest-prefix match, so a host project under a container's cwd stays local; they are written after the sides' entries and win over a side's claim on the same path.
    if (sides.posixLocal) {
      const l = local.result as ListLike;
      for (const p of [...l.sessions.map((s) => s.cwd), ...l.projects, ...l.recentProjects.map((x) => x.cwd), ...Object.values(l.worktrees ?? {}).flatMap((w) => w.map((x) => x.path))]) (sides.cwdSide.set(p, LOCAL_SIDE), delete cwdSides[p]);
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
        // Request IDs are unique across sides: the side that has it settles it.
        const answers = await Promise.all(all().map((id) => call(id, msg)));
        const settled = answers.some((a) => a.type === "reply" && (a.result as { settled?: boolean }).settled);
        return send(settled || answers[0]!.type === "reply" ? { type: "reply", reqId: msg.reqId, result: { settled } } : answers[0]!);
      }
      case "push.focus":
        // Each side suppresses pushes for the session shown here.
        for (const id of conns.keys()) void sideCall(id, msg);
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
        if (id !== LOCAL_SIDE) return send({ type: "error", reqId: msg.reqId, code: "side_unsupported", message: `Preview is not available for files in ${id.startsWith("docker:") ? "Docker" : "WSL"}` });
        return opts.local(msg);
      }
      default: {
        const id = await target(msg);
        if (id === LOCAL_SIDE) return opts.local(msg);
        const { side: _side, ...rest } = msg;
        return forward(id, rest as ClientMessage);
      }
    }
  }

  return {
    handle,
    close() {
      sides.removeRouter(router);
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
export function runSide(opts: { input: Readable; output: Writable; accept: (ws: SideSocket) => void; onEnd?: () => void }) {
  const sockets = new Map<number, SideSocket>();
  const write = (s: string) => opts.output.write(s + "\n");
  lines(opts.input, (line) => {
    let f: { c?: number; o?: unknown; m?: unknown; x?: unknown };
    try {
      f = JSON.parse(line);
    } catch {
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
