// A fake `docker` CLI for acceptance tests that need a container without Docker (GH-448). A sh script: it answers the calls the daemon makes
// (docker-side.ts) from a fixed configuration; nothing is run in any container. POSIX only (spawn("docker") finds no .cmd shim on Windows).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeDockerConfig = {
  /** Names `docker ps` lists. */
  containers: string[];
  /** Answer of the target probe (`docker exec <name> sh -c <probe>`). */
  probe: { code: number; stdout: string; stderr: string };
  /** Stdout of the check script (`CLAUDE_UI_CHECK k=v` lines). */
  check: { stdout: string };
  /** Answer of the setup script (prints `CLAUDE_UI_SETUP <code>`); the install ends here. */
  setup: { code: number; stdout: string };
  /** GH-458: one line per `docker` call (its first argument; `setup` for a setup exec, and `start` after it when the exec may start a Hub: `side --attach --start`) is appended here: the steps count them. */
  log?: string;
  /** GH-458, GH-578: the setup exec runs a real bridge (`main.ts side --attach [--start]`, the arguments the setup script ends with) as the container's claude-ui; its PID is written to `<home>/side.pid`. The bridge starts the Hub of the container (detached, `<home>/.config/claude-ui/daemon.json`). `projects`: its roots. */
  side?: { home: string; repo: string; projects: string };
};

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const answer = (a: { code?: number; stdout?: string; stderr?: string }) => `printf '%s' ${q(a.stdout ?? "")}; printf '%s' ${q(a.stderr ?? "")} >&2; exit ${a.code ?? 0}`;

/**
 * The script text. `exec`'s last argument is the script docker would run: the setup script says CLAUDE_UI_SETUP, the check script
 * `installed`, the target probe only `uname -m` (checked in this order; the check script contains the probe's lines too).
 */
/**
 * The side Hub's attach socket. Its config path is too long for `sun_path`, so it would fall back to `/tmp/claude-ui-<uid>/attach.sock`, which the
 * e2e daemon (same fallback) or another run may own: the side Hub then sees a live socket and exits. A short path of its own per side home.
 */
export const sideAttachSock = (home: string) => join(tmpdir(), `cui-e2e-${createHash("sha1").update(home).digest("hex").slice(0, 12)}`, "attach.sock");

export function fakeDockerScript(c: FakeDockerConfig): string {
  const log = (what: string) => (c.log ? `echo ${what} >> ${q(c.log)}; ` : "");
  // exec keeps the PID: kill of side.pid ends the bridge, like a dropped pipe. The Hub it started stays (detached, own PID in daemon.json), like in a container.
  // cwd = the repo, so `--import tsx` resolves; NODE_OPTIONS lets the detached Hub (same main.ts, started by the bridge) load tsx too. The script's last words are the cli arguments.
  const side = c.side && `mkdir -p ${q(c.side.home)}; echo $$ > ${q(join(c.side.home, "side.pid"))}; case "$s" in *"side --attach --start"*) a="side --attach --start";; *) a="side --attach";; esac; cd ${q(c.side.repo)} && exec env HOME=${q(c.side.home)} XDG_CONFIG_HOME=${q(join(c.side.home, ".config"))} CLAUDE_UI_ROOTS=${q(c.side.projects)} CLAUDE_UI_ATTACH_SOCK=${q(sideAttachSock(c.side.home))} NODE_OPTIONS="--import tsx" ${q(process.execPath)} packages/daemon/src/main.ts $a`;
  return `${c.log ? `echo "$1" >> ${q(c.log)}\n` : ""}case "$1" in
  version) echo linux;;
  ps) printf '%s\\n' ${c.containers.map(q).join(" ")};;
  inspect)
    case "$*" in
      *ReadonlyRootfs*) printf 'false\\n/data true\\nnull\\n';;
      *NetworkMode*) echo bridge;;
      *) echo true;;
    esac;;
  cp) exit 0;;
  exec)
    for a in "$@"; do s=$a; done
    case "$s" in
      *CLAUDE_UI_SETUP*) ${log("setup")}${c.log ? `case "$s" in *"side --attach --start"*) echo start >> ${q(c.log)};; esac; ` : ""}${side ?? answer(c.setup)};;
      *installed*) ${answer({ stdout: c.check.stdout })};;
      *"uname -m"*) ${answer(c.probe)};;
    esac
    exit 0;;
esac
exit 0
`;
}

/** Writes `<run>/bin/docker` (executable); returns `<run>/bin`, the folder to put first on the daemon's PATH. */
export function writeFakeDocker(run: string, c: FakeDockerConfig): string {
  const bin = join(run, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/bin/sh\n${fakeDockerScript(c)}`);
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
}
