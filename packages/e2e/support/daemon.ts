// Starts, restarts and stops the test daemon. No Playwright import: vitest tests the pure parts.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configHome, daemonConfigDir, projectsRoot } from "./paths.ts";

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
  restart(): Promise<void>;
  stop(): Promise<void>;
};

/** The config dirs of the owner's real install: where a test run must never write. */
export function realConfigDirs(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const dirs = [join(home, ".config", "claude-ui")];
  if (env.APPDATA) dirs.push(join(env.APPDATA, "claude-ui"));
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
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {}
    if (sig === "SIGTERM") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
}

/** The daemon's environment: own config dir and port, subscription login only, Haiku. */
export function daemonEnv(base: NodeJS.ProcessEnv, run: string, port: number): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_UI_TAILSCALE;
  delete env.CLAUDE_UI_HOSTNAME;
  return {
    ...env,
    XDG_CONFIG_HOME: configHome(run),
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
  const port = opts.port ?? (await freePort(ownerPorts()));
  if (ownerPorts().has(port)) throw new Error(`refusing to start a test daemon on ${port}: a real daemon uses it`);
  const log = join(run, `daemon-w${worker}.log`);
  const pidFile = join(run, `daemon-w${worker}.pid`);
  const configDir = daemonConfigDir(run);
  const state: { child?: ChildProcess; token: string } = { token: "" };

  async function launch(): Promise<void> {
    const fd = openSync(log, "a");
    const out: string[] = [];
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "packages/daemon/src/main.ts", "--port", String(port), "--roots", projectsRoot(run), "--no-open", "--no-update-check", "--no-os-notify"],
      { cwd: REPO_ROOT, env: daemonEnv(process.env, run, port), stdio: ["ignore", "pipe", fd], windowsHide: true, detached: process.platform !== "win32" },
    );
    closeSync(fd);
    state.child = child;
    writeFileSync(pidFile, String(child.pid));
    let exited: number | undefined;
    child.once("exit", (code) => (exited = code ?? -1));
    child.stdout!.on("data", (d: Buffer) => {
      out.push(String(d));
      try {
        appendFileSync(log, d);
      } catch {}
    });
    const wait = opts.timeoutMs ?? 90_000;
    const end = Date.now() + wait;
    for (;;) {
      const m = out.join("").match(TOKEN_RE);
      if (m) {
        state.token = m[1]!;
        break;
      }
      if (exited !== undefined) throw new Error(`the daemon exited (${exited}) before it listened:\n${tail(log)}`);
      if (Date.now() > end) {
        killTree(child.pid!);
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
    killTree(child.pid);
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
    async restart() {
      await stop();
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
