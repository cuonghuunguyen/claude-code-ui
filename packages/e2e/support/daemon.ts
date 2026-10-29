// Starts, restarts and stops the test daemon. No Playwright import: vitest tests the pure parts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheHome, configHome, daemonConfigDir, localAppData, projectsRoot } from "./paths.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const DEFAULT_PORT = 4280;
export const TOKEN_RE = /#token=([\w-]+)/;

export type Daemon = {
  port: number;
  origin: string;
  token: string;
  configDir: string;
  root: string;
  log: string;
  readonly pid: number;
  /** `pathPrefix`: a folder put first on the daemon's PATH from this start on (a fake docker); none: the normal PATH. */
  restart(o?: { pathPrefix?: string }): Promise<void>;
  stop(): Promise<void>;
};

/** The config dirs of the owner's real install: where a test run must never write. */
export function realConfigDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [join(home, ".config", "claude-ui")];
  if (env.APPDATA) dirs.push(join(env.APPDATA, "claude-ui"));
  // The runner's own XDG_CONFIG_HOME is the owner's real config dir, unless it is the run's (a nested run).
  const own = env.E2E_RUN_DIR ? daemonConfigDir(env.E2E_RUN_DIR) : "";
  const xdg = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "claude-ui") : "";
  if (xdg && xdg !== own && !dirs.includes(xdg)) dirs.push(xdg);
  return dirs;
}

/** Ports of daemons that run for real on this machine: 4280 and whatever their daemon.json says. */
export function ownerPorts(dirs: string[] = realConfigDirs(), read: (file: string) => string = (f) => readFileSync(f, "utf8")): Set<number> {
  const ports = new Set([DEFAULT_PORT]);
  for (const dir of dirs) {
    try {
      const port = Number(JSON.parse(read(join(dir, "daemon.json"))).port);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } catch {}
  }
  return ports;
}

const listenOnce = (port: number) =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(port, "127.0.0.1", () => {
      const got = (s.address() as { port: number }).port;
      s.close(() => res(got));
    });
  });

/** A free loopback port that is not in `exclude`; `E2E_PORT` wins when set (and must not be excluded). */
export async function freePort(exclude: Set<number>, preferred: string | undefined = process.env.E2E_PORT, listen: (port: number) => Promise<number> = listenOnce): Promise<number> {
  if (preferred) {
    const port = Number(preferred);
    if (exclude.has(port)) throw new Error(`E2E_PORT=${port} is the port of a real daemon; pick another`);
    return listen(port);
  }
  for (let i = 0; i < 50; i++) {
    const port = await listen(0);
    if (!exclude.has(port)) return port;
  }
  throw new Error("no free port found");
}

/** Command and arguments that end a process tree by PID (never by name). */
export function killCommand(pid: number, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  return platform === "win32" ? { cmd: "taskkill", args: ["/PID", String(pid), "/T", "/F"] } : { cmd: "kill", args: ["-TERM", `-${pid}`] };
}

export function killTree(pid: number): void {
  if (process.platform === "win32") {
    const { cmd, args } = killCommand(pid);
    spawnSync(cmd, args, { stdio: "ignore", windowsHide: true });
    return;
  }
  // POSIX: the daemon is its own process group (detached); signal the group.
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; alive() && waited < 3000; waited += 100) Atomics.wait(nap, 0, 0, 100);
  if (alive())
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
}

/** killTree without blocking the event loop: the group gets SIGTERM, then up to 3 s to go, then SIGKILL (POSIX); Windows kills the tree at once. */
export async function killTreeAsync(pid: number): Promise<void> {
  if (process.platform === "win32") return killTree(pid);
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  for (let waited = 0; alive() && waited < 3000; waited += 100) await sleep(100);
  if (alive())
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
}

/** The daemon's environment: own config dir and port, subscription login only, Haiku. */
export function daemonEnv(base: NodeJS.ProcessEnv, run: string, port: number, platform: NodeJS.Platform = process.platform, pathPrefix?: string): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  // Every inherited CLAUDE_UI_* (LAN, bypass, launcher, registry...) stays out; the ones the test needs are set below.
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_UI_")) delete env[key];
  return {
    ...env,
    XDG_CONFIG_HOME: configHome(run),
    // The Docker and WSL side parts (side-bundle.ts sideCacheDir) go under the run, never the owner's ~/.cache.
    XDG_CACHE_HOME: cacheHome(run),
    ...(pathPrefix ? { PATH: `${pathPrefix}${delimiter}${env.PATH ?? ""}` } : {}),
    // On Windows the daemon keeps uploads under LOCALAPPDATA whatever XDG_CONFIG_HOME says, and has no option for it (uploads.ts defaultUploadsDir).
    ...(platform === "win32" ? { LOCALAPPDATA: localAppData(run) } : {}),
    PORT: String(port),
    CLAUDE_UI_OPEN: "0",
    CLAUDE_UI_ROOTS: projectsRoot(run),
    ANTHROPIC_MODEL: "haiku",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });

async function waitPortClosed(port: number, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await portOpen(port))) return;
    await sleep(200);
  }
  throw new Error(`port ${port} still accepts connections ${ms} ms after the daemon was killed`);
}

function tail(file: string, lines = 30): string {
  try {
    return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

/** Starts the daemon with its own config dir and returns once the pairing URL is printed. */
export async function startDaemon(run: string, worker: number, opts: { port?: number; timeoutMs?: number } = {}): Promise<Daemon> {
  mkdirSync(projectsRoot(run), { recursive: true });
  mkdirSync(configHome(run), { recursive: true });
  mkdirSync(localAppData(run), { recursive: true });
  const port = opts.port ?? (await freePort(ownerPorts()));
  if (ownerPorts().has(port)) throw new Error(`refusing to start a test daemon on ${port}: a real daemon uses it`);
  const log = join(run, `daemon-w${worker}.log`);
  const pidFile = join(run, `daemon-w${worker}.pid`);
  const configDir = daemonConfigDir(run);
  const state: { child?: ChildProcess; token: string; pathPrefix?: string } = { token: "" };

  async function launch(): Promise<void> {
    const fd = openSync(log, "a");
    const out: string[] = [];
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/daemon/src/main.ts", "--port", String(port), "--roots", projectsRoot(run), "--no-open", "--no-update-check", "--no-os-notify"],
      { cwd: REPO_ROOT, env: daemonEnv(process.env, run, port, process.platform, state.pathPrefix), stdio: ["ignore", "pipe", fd], windowsHide: true, detached: process.platform !== "win32" },
    );
    closeSync(fd);
    state.child = child;
    writeFileSync(pidFile, String(child.pid));
    let exited: number | undefined;
    child.once("exit", (code) => {
      exited = code ?? -1;
      // A dead daemon's PID may be reused: teardown must not kill it. Remove the file only while it is still this child's.
      try {
        if (readFileSync(pidFile, "utf8") === String(child.pid)) rmSync(pidFile, { force: true });
      } catch {}
    });
    child.stdout!.on("data", (d: Buffer) => {
      out.push(String(d));
      try {
        appendFileSync(log, d);
      } catch {}
    });
    try {
      await ready(out, () => exited);
    } catch (e) {
      // A child that already exited needs no kill (its PID may be reused); either way it is no longer ours to stop.
      if (exited === undefined) await killTreeAsync(child.pid!);
      state.child = undefined;
      rmSync(pidFile, { force: true });
      throw e;
    }
  }

  /** Waits for the pairing URL, then checks the daemon used the scratch config and answers. */
  async function ready(out: string[], exitedCode: () => number | undefined): Promise<void> {
    const wait = opts.timeoutMs ?? 90_000;
    const end = Date.now() + wait;
    for (;;) {
      const m = out.join("").match(TOKEN_RE);
      if (m) {
        state.token = m[1]!;
        break;
      }
      const exited = exitedCode();
      if (exited !== undefined) throw new Error(`the daemon exited (${exited}) before it listened:\n${tail(log)}`);
      if (Date.now() > end) {
        throw new Error(`no pairing URL within ${wait} ms:\n${tail(log)}`);
      }
      await sleep(200);
    }
    const file = join(configDir, "daemon.json");
    if (!existsSync(file)) throw new Error(`daemon.json is not under the scratch config (${file}): the daemon used another config dir`);
    const info = JSON.parse(readFileSync(file, "utf8")) as { port: number };
    if (info.port !== port) throw new Error(`daemon.json says port ${info.port}, expected ${port}`);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    if (res.status !== 200) throw new Error(`GET / answered ${res.status}`);
  }

  async function stop(): Promise<void> {
    const child = state.child;
    if (!child?.pid) return;
    state.child = undefined;
    await killTreeAsync(child.pid);
    rmSync(pidFile, { force: true });
    await waitPortClosed(port);
  }

  await launch();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    token: state.token,
    configDir,
    root: projectsRoot(run),
    log,
    get pid() {
      return state.child?.pid ?? 0;
    },
    stop,
    async restart(o) {
      await stop();
      state.pathPrefix = o?.pathPrefix;
      for (let attempt = 1; ; attempt++) {
        try {
          await launch();
          return;
        } catch (e) {
          if (attempt >= 3) throw e;
          await sleep(1000);
        }
      }
    },
  };
}
