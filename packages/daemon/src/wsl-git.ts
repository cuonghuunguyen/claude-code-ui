// Git of a project in a WSL distro opened by its Windows path (`\\wsl$\<D>\...`, docs/spec.md "Sides"): runs inside the
// distro, never Windows git over the UNC path (spawn refuses a UNC cwd; safe.directory; slow).
import { homedir } from "node:os";
import { wslPathOf } from "@claude-ui/protocol";
import type { GitRunOptions, GitRunOutput, GitRunner } from "./git-runner.ts";

const FORWARD_ENV = ["GIT_TERMINAL_PROMPT", "GIT_NO_LAZY_FETCH", "GIT_OPTIONAL_LOCKS"];
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Only git's own switches cross into Linux, not the Windows environment. `GIT_CEILING_DIRECTORIES` (Windows `;` list) keeps the
 * entries that are paths in this distro, as POSIX (`:` list); Windows drive paths mean nothing there.
 */
export function wslEnv(env: NodeJS.ProcessEnv, distro: string): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(FORWARD_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]!]));
  const ceiling = (env.GIT_CEILING_DIRECTORIES ?? "")
    .split(";")
    .flatMap((e) => {
      const p = wslPathOf(e);
      return p && p.distro.toLowerCase() === distro.toLowerCase() ? [p.posix] : [];
    });
  if (ceiling.length) out.GIT_CEILING_DIRECTORIES = ceiling.join(":");
  return out;
}

/** Shell script run by bash in the distro: cd, git's env, exec git. */
export function wslGitScript(posix: string, args: string[], env: Record<string, string>): string {
  return [`cd -- ${q(posix)} || exit 128`, ...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`), `exec git ${args.map(q).join(" ")}`].join("\n");
}

/** wsl.exe arguments: the script travels base64-encoded (like `wslArgs`), bash without login files. */
export const wslGitArgs = (distro: string, script: string) => ["-d", distro, "--exec", "bash", "-c", `. <(echo ${Buffer.from(script).toString("base64")} | base64 -d)`];

/** A side transport failure (side not ready / exited): the caller may use wsl.exe instead. */
export class SideGone extends Error {}

export type WslGitOptions = {
  local: GitRunner;
  /** Ready side ID for a distro (case-insensitive), else undefined. */
  side?: (distro: string) => string | undefined;
  /** Runs git in that side; rejects SideGone when the side is not there. */
  sideRun?: (id: string, o: GitRunOptions) => Promise<GitRunOutput>;
};

/** A UNC WSL cwd: the ready side of its distro, else one `wsl.exe` process; any other cwd: `local`. */
export function wslGitRunner(o: WslGitOptions): GitRunner {
  return (r) => {
    const w = wslPathOf(r.cwd);
    if (!w) return o.local(r);
    const same = (d: string) => d.toLowerCase() === w.distro.toLowerCase();
    const args = r.args.map((a) => {
      const p = wslPathOf(a);
      return p && same(p.distro) ? p.posix : a;
    });
    const env = wslEnv(r.env, w.distro);
    const viaExe = () => o.local({ ...r, file: "wsl.exe", cwd: homedir(), args: wslGitArgs(w.distro, wslGitScript(w.posix, args, env)), env: process.env });
    const id = o.side?.(w.distro);
    if (!id || !o.sideRun) return viaExe();
    return o.sideRun(id, { ...r, cwd: w.posix, args, env }).catch((e) => (e instanceof SideGone ? viaExe() : Promise.reject(e)));
  };
}
