// Client side of the CLI commands: port, token, liveness probe, one request over the daemon's WebSocket (docs/spec.md "CLI").
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { readDaemonFile } from "./daemon-file.ts";

export const DEFAULT_PORT = 4280;
const TIMEOUT_MS = 10_000;

/** `exit`: process exit code (1 daemon error, 2 usage, 3 daemon unreachable or no token). `code`: stable name in `--json` errors. */
export class CtlError extends Error {
  constructor(
    readonly exit: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** `--port`, then `PORT`, then the port of a live daemon.json, then 4280. */
export function resolvePort(o: { flag?: number; env: NodeJS.ProcessEnv; dir: string; alive?: (pid: number) => boolean }): number {
  if (o.flag !== undefined) return o.flag;
  if (o.env.PORT && /^\d+$/.test(o.env.PORT)) return Number(o.env.PORT);
  const info = readDaemonFile(o.dir);
  return info && (o.alive ?? pidAlive)(info.pid) ? info.port : DEFAULT_PORT;
}

/** Reads the token file; never creates it. */
export function readToken(file: string, explicit = false): string {
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new CtlError(3, "no_token", `cannot read ${file}: ${(e as Error).message}`);
  }
  if (explicit) throw new CtlError(3, "no_token", `token file not found: ${file}`);
  throw new CtlError(3, "no_token", `no token at ${file}: the daemon never started on this machine (start it with claude-ui, or pass --token-file)`);
}

/** The token file: `--token-file`, `CLAUDE_UI_TOKEN_FILE` or the config dir's; `explicit`: the user named it. */
export const tokenPath = (o: { tokenFile?: string; env: NodeJS.ProcessEnv; dir: string }) => {
  const file = o.tokenFile ?? o.env.CLAUDE_UI_TOKEN_FILE;
  return { file: file ?? join(o.dir, "token"), explicit: file !== undefined };
};

const inWsl = () => process.platform === "linux" && /microsoft/i.test(release());
const notRunning = (port: number) =>
  new CtlError(3, "not_running", `claude-ui daemon not running on 127.0.0.1:${port}.` + (inWsl() ? " A daemon on Windows is out of reach from WSL: run claude-ui from PowerShell, or use WSL mirrored networking and --token-file /mnt/c/Users/<you>/AppData/Roaming/claude-ui/token" : ""));

/** `GET /auth`: the daemon answers and takes the token. */
export async function probe(port: number, token: string) {
  let status: number;
  try {
    status = (await fetch(`http://127.0.0.1:${port}/auth`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })).status;
  } catch {
    throw notRunning(port);
  }
  if (status === 401) throw new CtlError(3, "token_rejected", `token rejected by the daemon on 127.0.0.1:${port}`);
  if (status !== 204) throw new CtlError(3, "not_running", `127.0.0.1:${port} answers, but not as a claude-ui daemon (HTTP ${status})`);
}

/** One request, one reply; Origin matches the daemon's own origin as a browser tab's does. */
export function request<T>(port: number, token: string, msg: { type: string } & Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
    const reqId = `ctl-${process.pid}-${Date.now()}`;
    const done = (fn: () => void) => (clearTimeout(timer), ws.terminate(), fn());
    const timer = setTimeout(() => done(() => reject(new CtlError(1, "timeout", `no answer from the daemon within ${TIMEOUT_MS / 1000} s`))), TIMEOUT_MS);
    ws.on("open", () => ws.send(JSON.stringify({ ...msg, reqId })));
    ws.on("error", () => done(() => reject(notRunning(port))));
    ws.on("close", () => done(() => reject(new CtlError(3, "not_running", "the daemon closed the connection"))));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.reqId !== reqId) return;
      if (m.type === "reply") done(() => resolve(m.result as T));
      else if (m.type === "error") done(() => reject(new CtlError(1, m.code ?? "error", m.message ?? "request failed")));
    });
  });
}
