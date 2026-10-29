// A fake `docker` CLI for acceptance tests that need a container without Docker (GH-448). A sh script: it answers the calls the daemon makes
// (docker-side.ts) from a fixed configuration; nothing is run in any container. POSIX only (spawn("docker") finds no .cmd shim on Windows).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
  /** GH-458: one line per `docker` call (its first argument; `setup` for a setup exec) is appended here: the steps count them. */
  log?: string;
  /** GH-458: the setup exec runs a real side (`main.ts --side`) as the container's claude-ui; its PID is written to `<home>/side.pid`. `projects`: its roots. */
  side?: { home: string; repo: string; projects: string };
};

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const answer = (a: { code?: number; stdout?: string; stderr?: string }) => `printf '%s' ${q(a.stdout ?? "")}; printf '%s' ${q(a.stderr ?? "")} >&2; exit ${a.code ?? 0}`;

/**
 * The script text. `exec`'s last argument is the script docker would run: the setup script says CLAUDE_UI_SETUP, the check script
 * `installed`, the target probe only `uname -m` (checked in this order; the check script contains the probe's lines too).
 */
export function fakeDockerScript(c: FakeDockerConfig): string {
  const log = (what: string) => (c.log ? `echo ${what} >> ${q(c.log)}; ` : "");
  // exec keeps the PID: kill of side.pid ends the side, like a container's process ending. cwd = the repo, so `--import tsx` resolves.
  const side = c.side && `mkdir -p ${q(c.side.home)}; echo $$ > ${q(join(c.side.home, "side.pid"))}; cd ${q(c.side.repo)} && exec env HOME=${q(c.side.home)} XDG_CONFIG_HOME=${q(join(c.side.home, ".config"))} ${q(process.execPath)} --import tsx packages/daemon/src/main.ts --side --roots ${q(c.side.projects)}`;
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
      *CLAUDE_UI_SETUP*) ${log("setup")}${side ?? answer(c.setup)};;
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
