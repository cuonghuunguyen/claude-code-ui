// The client commands (docs/spec.md "CLI"): status, open, sessions, projects, workers. Text by default, `--json` for scripts.
// The token is never written to stdout or stderr except by `open --print`.
import { spawn } from "node:child_process";
import { release } from "node:os";
import { resolve } from "node:path";
import type { ListResult, SessionListItem } from "@claude-ui/protocol";
import type { Cli } from "../cli.ts";
import { CtlError, probe, readToken, request, resolvePort, tokenPath } from "./connect.ts";
import { readDaemonFile } from "./daemon-file.ts";

export type ClientIo = {
  env: NodeJS.ProcessEnv;
  /** The config dir: token and daemon.json. */
  dir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  openUrl: (url: string) => Promise<void>;
  /** Replaces the daemon's `session.list` reply (tests). */
  request?: () => Promise<ListResult>;
};

type Client = Extract<Cli, { kind: "client" }>;

/** Runs a client command; resolves with the process exit code (0 ok, 1 daemon error, 2 usage, 3 daemon unreachable or no token). */
export async function runClient(cli: Client, io: ClientIo): Promise<number> {
  const out = (s: string) => io.stdout(s.endsWith("\n") ? s : s + "\n");
  const json = (v: unknown) => out(JSON.stringify(v, null, 2));
  try {
    const port = resolvePort({ flag: cli.port, env: io.env, dir: io.dir });
    const tp = tokenPath({ tokenFile: cli.tokenFile, env: io.env, dir: io.dir });
    const token = readToken(tp.file, tp.explicit);
    await probe(port, token);
    const list = () => (io.request ? io.request() : request<ListResult>(port, token, { type: "session.list" }));
    const url = `http://127.0.0.1:${port}/`;
    switch (cli.cmd) {
      case "status": {
        const l = await list();
        const live = l.sessions.filter((s) => !s.archived);
        const byState: Record<string, number> = {};
        for (const s of live) byState[s.state] = (byState[s.state] ?? 0) + 1;
        const file = readDaemonFile(io.dir);
        const info = file?.port === port ? file : undefined;
        const sides = l.sides?.map(({ id, label, state }) => ({ id, label, state }));
        if (cli.json) json({ running: true, port, ...(info && { version: info.version, pid: info.pid, startedAt: info.startedAt }), sessions: { total: live.length, byState }, needsInput: byState.needs_input ?? 0, projects: l.projects.length, ...(sides && { sides }) });
        else
          out(
            `claude-ui${info ? ` ${info.version}` : ""} running on 127.0.0.1:${port}${info ? ` (pid ${info.pid}, since ${info.startedAt})` : ""}\n` +
              `sessions: ${live.length}${live.length ? ` (${Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}, needs input: ${byState.needs_input ?? 0}, projects: ${l.projects.length}` +
              (sides?.length ? `\nsides: ${sides.map((s) => `${s.label} ${s.state}`).join(", ")}` : ""),
          );
        return 0;
      }
      case "sessions": {
        const project = cli.project && resolve(cli.project);
        const rows = (await list()).sessions.filter((s) => (cli.archived || !s.archived) && (!project || s.cwd === project) && (!cli.state || s.state === cli.state));
        if (cli.json) json(rows);
        else out(rows.length ? table(["ID", "STATE", "PROJECT", "ACTIVITY", "TITLE"], rows.map(row)) : "No sessions.");
        return 0;
      }
      case "projects": {
        const l = await list();
        if (cli.json) json({ projects: l.projects, recentProjects: l.recentProjects });
        else out(l.projects.length ? l.projects.join("\n") : "No projects.");
        return 0;
      }
      case "workers": {
        const l = await list();
        const workers = l.sessions.filter((s) => s.coordinatorId && s.workerName);
        if (cli.json) return json(workers), 0;
        if (!workers.length) return out("No workers."), 0;
        const byId = new Map(l.sessions.map((s) => [s.id, s]));
        const title = (id: string) => byId.get(id)?.title;
        const depth = (id: string) => {
          let d = 0;
          for (let cur = byId.get(id); cur?.coordinatorId && d < 20; d++) cur = byId.get(cur.coordinatorId);
          return d;
        };
        const groups = new Map<string, SessionListItem[]>();
        for (const w of workers) groups.set(w.coordinatorId!, [...(groups.get(w.coordinatorId!) ?? []), w]);
        // A worker that has workers heads a group too: its header names the worker row it is (and its coordinator).
        const header = (id: string) => {
          const me = byId.get(id);
          const own = me?.coordinatorId && me.workerName ? ` (worker ${me.workerName} of ${me.coordinatorId})` : "";
          return `coordinator ${id}${title(id) ? ` ${oneLine(title(id)!)}` : ""}${own}`;
        };
        const ordered = [...groups].sort(([a], [b]) => depth(a) - depth(b));
        out(ordered.map(([id, ws]) => `${header(id)}\n${table(["WORKER", "STATE", "ID", "ACTIVITY"], ws.map((w) => [w.workerName!, w.state, w.id, when(w.lastActivity)]))}`).join("\n\n"));
        return 0;
      }
      case "open": {
        let target = `${url}#token=${token}`;
        if (cli.sessionId) {
          const found = (await list()).sessions.some((s) => s.id === cli.sessionId);
          if (!found) throw new CtlError(1, "not_found", `no session ${cli.sessionId}`);
          // The pairing fragment replaces the session fragment: a deep link opens in a browser that is already paired.
          target = `${url}#${cli.sessionId}`;
        }
        if (cli.print) return out(target), 0;
        try {
          await io.openUrl(target);
        } catch (e) {
          throw new CtlError(1, "open_failed", `cannot open a browser: ${(e as Error).message}; use --print`);
        }
        out(cli.sessionId ? `Opened session ${cli.sessionId} in the browser.` : "Opened claude-ui in the browser.");
        return 0;
      }
    }
  } catch (e) {
    if (!(e instanceof CtlError)) throw e;
    io.stderr((cli.json ? JSON.stringify({ error: { code: e.code, message: e.message } }) : `claude-ui: ${e.message}`) + "\n");
    return e.exit;
  }
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 60);
const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "");
const row = (s: SessionListItem) => [s.id, s.state + (s.archived ? " (archived)" : ""), s.cwd, when(s.lastActivity), (s.workerName ? `[worker ${s.workerName}] ` : s.coordinator ? "[coordinator] " : "") + oneLine(s.title)];
const table = (head: string[], rows: string[][]) => {
  const all = [head, ...rows];
  const w = head.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]!))).join("  ").trimEnd()).join("\n");
};

/** How long an opener may run before it counts as launched (xdg-open may stay while the browser starts). */
const OPENER_WAIT_MS = 5_000;

/** Runs the opener; rejects when it cannot start or exits non-zero (a launcher that was still running after OPENER_WAIT_MS counts as launched). */
export function runOpener(cmd: string, args: string[], waitMs = OPENER_WAIT_MS): Promise<void> {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => (c.unref(), ok()), waitMs);
    c.once("error", (e) => (clearTimeout(timer), fail(e)));
    c.once("exit", (code) => (clearTimeout(timer), code ? fail(new Error(`${cmd} exited with code ${code}`)) : ok()));
  });
}

/** Opens `url` in the default browser: `open` on macOS, `cmd /c start` on Windows, `cmd.exe /c start` in WSL, else xdg-open. */
export function openInBrowser(url: string): Promise<void> {
  const wsl = process.platform === "linux" && /microsoft/i.test(release());
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : wsl ? ["cmd.exe", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return runOpener(cmd, args);
}
