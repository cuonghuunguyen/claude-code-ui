// Updates (docs/spec.md "Updates"): the daemon checks the npm registry for a newer claude-code-ui, installs it on request into
// its own versions dir (`npm install --prefix`, no global install, no sudo) and exits with RESTART_CODE once every session is
// idle; the launcher (launcher.ts) then starts the newest installed version.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage, UpdateState } from "@claude-ui/protocol";
import { configDir } from "./token.ts";

export const PACKAGE = "claude-code-ui";
export const REGISTRY = "https://registry.npmjs.org";
/** Exit code of a daemon that wants the launcher to start it again (EX_TEMPFAIL). */
export const RESTART_CODE = 75;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** A waiting restart exits this long after the last busy session went idle: Claude may start a turn on a finished background task. */
export const RESTART_GRACE_MS = 5000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Plain release versions only: the registry answer and directory names are checked against this before any use. */
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
export const isVersion = (v: unknown): v is string => typeof v === "string" && VERSION.test(v);
export function compareVersions(a: string, b: string) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

/** Where updates install, one folder per version. */
export const versionsDir = () => join(configDir(), "versions");

/** The daemon script of an installed version dir. */
export const versionCli = (dir: string, v: string) => join(dir, v, "node_modules", PACKAGE, "dist", "cli.js");

/** File the launcher leaves in a version dir whose daemon failed to start: the launcher skips it (a reinstall removes it). */
export const FAILED_MARK = "failed-start";

/** The installed versions in `dir` (complete installs that did not fail to start), newest first. */
export function installedVersions(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((v) => isVersion(v) && existsSync(versionCli(dir, v)) && !existsSync(join(dir, v, FAILED_MARK))).sort((a, b) => compareVersions(b, a));
}

/**
 * After a successful start of `current`: removes the version dirs older than the newest one older than `current` (kept as the
 * previous). Newer versions, `.partial` installs (maybe of another daemon) and other names stay.
 */
export function pruneVersions(dir: string, current: string) {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const previous = names.filter((v) => isVersion(v) && compareVersions(v, current) < 0).sort((a, b) => compareVersions(b, a))[0];
  if (!previous) return;
  for (const n of names) if (isVersion(n) && compareVersions(n, previous) < 0) rmSync(join(dir, n), { recursive: true, force: true });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * `CLAUDE_UI_UPDATE_REGISTRY`: a registry mirror (or a local fake one). https only, plain http only on loopback; a plain URL
 * (no quotes, spaces or `%`: it reaches npm's command line, a shell on Windows). Undefined when unset; throws when invalid.
 */
export function parseRegistry(value: string | undefined): string | undefined {
  const v = value?.replace(/\/+$/, "");
  if (!v) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(v);
  } catch {}
  const ok = url && /^https?:\/\/[\w.:@/\[\]-]+$/.test(v) && (url.protocol === "https:" || LOOPBACK.has(url.hostname));
  if (!ok) throw new Error("CLAUDE_UI_UPDATE_REGISTRY must be an https URL (http only for 127.0.0.1, localhost or [::1]) of letters, digits and . : @ / - _");
  return v;
}

/** The registry's latest version when it is newer than `current`; undefined on the same or older version and on any failure. */
export async function latestNewer(current: string, opts: { registry?: string; fetch?: typeof fetch } = {}) {
  if (!isVersion(current)) return undefined;
  try {
    const r = await (opts.fetch ?? fetch)(`${opts.registry ?? REGISTRY}/${PACKAGE}/latest`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return undefined;
    const version = ((await r.json()) as { version?: unknown } | null)?.version;
    return isVersion(version) && compareVersions(version, current) > 0 ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Runs a command; resolves with its exit code and combined output. */
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; output: string }>;

export const runCommand: Runner = (cmd, args) =>
  new Promise((resolve) => {
    // Windows: npm is npm.cmd, which Node starts only through a shell: every argument is quoted, so `&` or spaces in the config
    // path stay text (Windows paths have no `"`; versions and the registry URL are checked). ponytail: `%NAME%` in a path still expands.
    const win = process.platform === "win32";
    const child = spawn(win ? `${cmd}.cmd` : cmd, win ? args.map((a) => `"${a}"`) : args, { shell: win, windowsHide: true, timeout: INSTALL_TIMEOUT_MS });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("error", (err) => resolve({ code: null, output: `${output}\n${err.message}` }));
    child.on("close", (code) => resolve({ code, output }));
  });

/**
 * Installs `version` into `<dir>/<version>`: npm installs into `<version>.partial` first, so a cut install is never picked by
 * the launcher. Resolves when the install has exactly that version; rejects with npm's last lines otherwise.
 */
export async function installVersion(dir: string, version: string, opts: { registry?: string; run?: Runner } = {}) {
  if (!isVersion(version)) throw new Error(`invalid version ${version}`);
  const target = join(dir, version);
  if (installedVersions(dir).includes(version)) return;
  const partial = `${target}.partial`;
  rmSync(partial, { recursive: true, force: true });
  // The registry the check asked, not the one of the user's npm config.
  const args = ["install", "--prefix", partial, "--omit=dev", "--no-save", "--no-fund", "--no-audit", "--loglevel=error", "--registry", opts.registry ?? REGISTRY, `${PACKAGE}@${version}`];
  const { code, output } = await (opts.run ?? runCommand)("npm", args);
  const fail = (why: string) => {
    rmSync(partial, { recursive: true, force: true });
    throw new Error(why);
  };
  if (code !== 0) fail(output.trim().split("\n").slice(-3).join("\n") || `npm exited with ${code}`);
  let got: unknown;
  try {
    got = JSON.parse(readFileSync(join(partial, "node_modules", PACKAGE, "package.json"), "utf8")).version;
  } catch {}
  if (got !== version || !existsSync(join(partial, "node_modules", PACKAGE, "dist", "cli.js"))) fail(`npm installed ${String(got ?? "nothing")}, not ${version}`);
  try {
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
  } catch (err) {
    fail(`could not move the install into ${target}: ${(err as Error).message}`);
  }
}

type UpdateMessage = Extract<ServerMessage, { type: "update_available" | "update_state" }>;

/**
 * `busy`: sessions with a running turn, pending input or a running subagent run, and running terminals.
 * `exit`: ends the daemon with the code. `broadcast`: to every connection.
 */
export function createUpdater(opts: {
  current: string;
  dir: string;
  registry?: string;
  fetch?: typeof fetch;
  run?: Runner;
  busy: () => { sessions: number; terminals: number };
  exit: (code: number) => void;
  broadcast: (m: UpdateMessage) => void;
  pollMs?: number;
  graceMs?: number;
}) {
  let available: string | undefined;
  let installed: string | undefined;
  let installing: Promise<string> | undefined;
  let state: UpdateState | undefined;
  let waiting: ReturnType<typeof setInterval> | undefined;
  const setState = (s: UpdateState | undefined) => {
    state = s;
    if (s) opts.broadcast({ type: "update_state", ...s });
    else if (available) opts.broadcast({ type: "update_available", version: available, current: opts.current });
  };
  const restartNow = () => {
    clearInterval(waiting);
    setState({ phase: "restarting" });
    opts.exit(RESTART_CODE);
  };

  async function check() {
    const v = await latestNewer(opts.current, opts);
    if (v && v !== available && !state) {
      available = v;
      opts.broadcast({ type: "update_available", version: v, current: opts.current });
    }
    return v;
  }

  return {
    check,
    /** Checks now and every CHECK_INTERVAL_MS. */
    start() {
      void check();
      setInterval(check, CHECK_INTERVAL_MS).unref();
    },
    /** What a new connection gets: the available version and the update under way. */
    messages(): UpdateMessage[] {
      if (!available) return [];
      return [{ type: "update_available", version: available, current: opts.current }, ...(state ? [{ type: "update_state" as const, ...state }] : [])];
    },
    /** Installs the available version (once; a second call waits for the first). The daemon keeps running on failure. */
    install(): Promise<string> {
      const v = available;
      if (!v) return Promise.reject(new Error("no update available"));
      if (installed === v) return Promise.resolve(v);
      installing ??= (async () => {
        setState({ phase: "installing" });
        try {
          await installVersion(opts.dir, v, opts);
          installed = v;
          // Silent: update.restart, which follows, sets the next phase.
          state = undefined;
          return v;
        } catch (err) {
          // Every connection is back at "available".
          setState(undefined);
          throw err;
        } finally {
          installing = undefined;
        }
      })();
      return installing;
    },
    /**
     * Exits RESTART_CODE once no session is busy for `graceMs` (`now`: at once). Nothing busy but open terminals: once they
     * are closed, or `now`. Returns the busy sessions it waits for.
     */
    restart(now = false): number {
      if (!installed) throw new Error("no update installed");
      const first = opts.busy();
      if (now || (!first.sessions && !first.terminals)) return (restartNow(), 0);
      // Only terminals open: a restart closes them, so it waits until they are closed or "Restart now" (the notice names
      // them). Busy sessions: it waits until none is busy for graceMs; the terminals then close with it.
      let forSessions = first.sessions > 0;
      let idleSince: number | undefined;
      const show = (b: { sessions: number; terminals: number }) => {
        const w = state?.phase === "waiting" ? state : undefined;
        if (b.sessions !== w?.waitingFor || b.terminals !== w?.terminals) setState({ phase: "waiting", waitingFor: b.sessions, terminals: b.terminals });
      };
      show(first);
      clearInterval(waiting);
      // ponytail: polls the session states and terminal count; listeners if the delay matters.
      waiting = setInterval(() => {
        const b = opts.busy();
        if (b.sessions) {
          forSessions = true;
          idleSince = undefined;
          return show(b);
        }
        if (!forSessions) return b.terminals ? show(b) : restartNow();
        // Idle for the whole grace period: exit. Busy again meanwhile: the grace period starts over at the next idle.
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= (opts.graceMs ?? RESTART_GRACE_MS)) restartNow();
      }, opts.pollMs ?? 1000).unref();
      return first.sessions;
    },
  };
}

export type Updater = ReturnType<typeof createUpdater>;
