// WSL distros (Windows) and running Linux Docker containers (any OS) (docs/spec.md "Sides"): the daemon (hub) also serves each
// of them through a side: the same daemon run inside the distro or container with `--side`, without HTTP, speaking the wire protocol over its stdio. The hub routes each
// browser request to the side that owns its session, terminal or path; one URL, one pairing, one page for every side.
// Frames are JSON lines. hub -> side: {c, o} opens virtual connection c, {c, m} a client message, {c, x} closes it.
// side -> hub: {ready} once listening, {c, m} a server message, {push} a Web Push payload. Other stdout lines are ignored.
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { LOCAL_SIDE, type ClientMessage, type PushPayload, type ServerMessage, type SettingsResult, type Settings, type SideInfo } from "@claude-ui/protocol";

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
      return docker ? `Claude is not logged in in ${side}. Run claude login in the container or copy your ~/.claude/.credentials.json into it (or start it with ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set), then retry.` : `Claude is not logged in in ${side}. Run claude login there, then retry.`;
    case "build_tools_missing":
      return `${side} needs make, python3 and g++ to build the terminal support (node-pty). Install them there (Debian/Ubuntu: apt-get install -y make python3 g++; Alpine: apk add make python3 g++), then retry.`;
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
export function setupScript(source: string, key: string, kind: "wsl" | "docker" = "wsl") {
  const docker = kind === "docker";
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
    ...(docker ? [`src='${src}'`] : []),
    // npm skips an optional dependency it could not fetch: without the SDK's Linux binary (any arch or libc) the side lists no
    // models (no auto mode) and runs no query. Such an install is installed again.
    'sdk() { for b in "$dir"/node_modules/@anthropic-ai/claude-agent-sdk-linux-*; do [ -d "$b" ] && return 0; done; return 1; }',
    'if [ ! -f "$cli" ] || ! sdk; then',
    docker
      ? `  [ -f "$src" ] || say install_failed "the claude-ui package was not copied in"`
      : `  src=$(wslpath -u '${src}') && [ -f "$src/dist/cli.js" ] || say install_failed "the Windows claude-ui package was not found"`,
    // node-pty has no Linux prebuilds: npm install compiles it.
    "  { command -v make && command -v python3 && { command -v g++ || command -v c++; }; } >/dev/null 2>&1 || say build_tools_missing",
    // From scratch: npm does not fetch an optional dependency again into a node_modules that lacks it.
    '  rm -rf "$dir"; mkdir -p "$dir" || say install_failed',
    `  out=$(npm install --prefix "$dir" ${docker ? "" : "--install-links "}--omit=dev --no-save --no-fund --no-audit --loglevel=error "$src" 2>&1 >/dev/null) || { rm -rf "$dir"; say install_failed "$(printf '%s' "$out" | tail -n 3 | tr '\\n' ' ')"; }`,
    '  [ -f "$cli" ] || { rm -rf "$dir"; say install_failed "the package has no dist/cli.js"; }',
    '  sdk || { rm -rf "$dir"; say install_failed "npm did not install the Claude Agent SDK binary for Linux (an optional dependency)"; }',
    // Earlier versions and builds.
    '  for d in "$root"/*; do [ "$d" = "$dir" ] || rm -rf "$d"; done',
    "fi",
    ...(docker ? ['rm -f "$src" 2>/dev/null', '[ -n "$CLAUDE_UI_ROOTS" ] || case "$PWD" in /|"$HOME"|"$HOME"/*) export CLAUDE_UI_ROOTS="$HOME" ;; *) export CLAUDE_UI_ROOTS="$HOME:$PWD" ;; esac'] : []),
    'exec node "$cli" --side',
  ].join("\n");
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
  spawn: (id: string) => SideProcess | Promise<SideProcess>;
  /** Label of this daemon's own side (default "Windows"). */
  localLabel?: string;
  /** Dynamic sides (Docker containers), called by refresh(); never rejects (returns [] on failure). */
  discover?: () => Promise<SideTarget[]>;
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
    start(id).catch((e) => console.error(`starting ${id} failed:`, (e as Error).message));
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

  function start(id: string): Promise<void> {
    const s = sides.get(id);
    if (!s) return Promise.reject(new Error(`unknown side ${id}`));
    if (s.state === "ready") return Promise.resolve();
    if (s.starting) return s.starting;
    Object.assign(s, { state: "starting", message: undefined });
    changed();
    s.starting = (async () => {
      let proc: SideProcess;
      try {
        proc = await opts.spawn(s.id);
      } catch (e) {
        const raw = (e as Error).message;
        const message = raw.startsWith(s.label) ? raw : `${s.label}: ${raw}`;
        Object.assign(s, { state: "error", message, proc: undefined });
        changed();
        throw new Error(message);
      }
      await new Promise<void>((resolve, reject) => {
      s.proc = proc;
      let setupError: string | undefined;
      let stderr = "";
      proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d).slice(-2000)));
      proc.stdin.on("error", () => {});
      lines(proc.stdout, (line) => {
        const setup = /^CLAUDE_UI_SETUP (\S+) ?(.*)$/.exec(line.trim());
        if (setup) return void (setupError = setupMessage(setup[1]!, setup[2]!, s.label, isDocker(s.id)));
        let f: { ready?: boolean; c?: number; m?: ServerMessage; push?: PushPayload };
        try {
          f = JSON.parse(line);
        } catch {
          // Shell start-up output (motd, .bashrc).
          return;
        }
        if (f.ready) {
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
        const tail = stderr.trim().split("\n").filter((l) => !/cannot set terminal process group|no job control/.test(l)).slice(-3).join(" ");
        const message = setupError ?? (wasReady ? `${s.label} stopped (exit code ${code}). Retry to start it again.` : `${s.label} could not start (exit code ${code})${tail ? `: ${tail}` : ""}.`);
        Object.assign(s, { state: "error", message, proc: undefined, starting: undefined });
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
    return (discovering = opts
      .discover()
      .then(
        (found) => {
          let diff = false;
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
    list: (): SideInfo[] => [{ id: LOCAL_SIDE, label: opts.localLabel ?? "Windows", state: "ready" }, ...[...sides.values()].map(({ id, label, state, message }) => ({ id, label, state, ...(message && { message }) }))],
    has: (id: string) => sides.has(id),
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
    return { type: "reply", reqId: msg.reqId, result: { ...merged, sides: sides.list(), cwdSides } };
  }

  async function handle(msg: ClientMessage & Record<string, unknown>) {
    switch (msg.type) {
      case "session.list":
        return send(await mergedList(msg));
      case "side.start": {
        if (typeof msg.side !== "string" || !sides.has(msg.side)) return send({ type: "error", reqId: msg.reqId, code: "unknown_side", message: `unknown side ${String(msg.side)}` });
        try {
          await sides.start(msg.side);
          router.attach(msg.side);
          return send({ type: "reply", reqId: msg.reqId, result: {} });
        } catch (e) {
          return send({ type: "error", reqId: msg.reqId, code: "side_failed", message: (e as Error).message });
        }
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
