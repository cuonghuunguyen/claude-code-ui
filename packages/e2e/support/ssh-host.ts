// A throwaway sshd for the SSH Side acceptance (GH-546): a Debian container (glibc, so the bundle covers it) with sshd, git and tar, key login only,
// no Claude login. Everything ssh reads lives under <run>/ssh (the config the daemon gets as CLAUDE_UI_SSH_CONFIG, the keys, known_hosts): the owner's ~/.ssh is never touched.
// Pure Node (no Playwright import). Needs `docker`, `ssh`, `ssh-keygen`, `ssh-keyscan` on PATH and network for the image and apt.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sshDir } from "./paths.ts";

export const SSH_ALIASES = { ok: "e2e-ok", hostKey: "e2e-hostkey", auth: "e2e-auth", down: "e2e-down" } as const;
/** The project folder the container starts with: a git repo with one untracked file. */
export const REMOTE_PROJECT = "/root/e2e-proj";

const sh = (cmd: string, args: string[], timeout = 60_000) => execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ssh config text: four hosts on one sshd (or a closed port), each with its own keys and known_hosts file. */
export function sshConfigText(o: { dir: string; port: number; closedPort: number }): string {
  const common = (name: string, port: number, key: string, known: string) =>
    [`Host ${name}`, "  HostName 127.0.0.1", `  Port ${port}`, "  User root", `  IdentityFile ${join(o.dir, key)}`, "  IdentitiesOnly yes", "  PasswordAuthentication no", `  UserKnownHostsFile ${join(o.dir, known)}`, "  StrictHostKeyChecking yes", "  LogLevel ERROR", ""].join("\n");
  return [
    common(SSH_ALIASES.ok, o.port, "id_ok", "known_hosts"),
    // Never trusted: strict checking fails on the unknown key.
    common(SSH_ALIASES.hostKey, o.port, "id_ok", "known_hosts_empty"),
    // A key the container does not know.
    common(SSH_ALIASES.auth, o.port, "id_bad", "known_hosts"),
    common(SSH_ALIASES.down, o.closedPort, "id_ok", "known_hosts"),
  ].join("\n");
}

const BOOT = [
  "apt-get update -qq",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server tar gzip git procps >/dev/null",
  "mkdir -p /run/sshd /root/.ssh",
  'echo "$PUBKEY" > /root/.ssh/authorized_keys',
  "chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys",
  `mkdir -p ${REMOTE_PROJECT} && cd ${REMOTE_PROJECT} && git init -q && echo e2e > hello.txt`,
  "exec /usr/sbin/sshd -D -e",
].join(" && ");

export type SshHost = { name: string; port: number; config: string; stop(): void };

/** Starts the container and writes <run>/ssh/{config,id_ok,id_bad,known_hosts,known_hosts_empty}. Resolves when sshd answers. */
export async function startSshHost(run: string): Promise<SshHost> {
  const dir = sshDir(run);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // A worker that restarts (a retry) finds the keys of the first one: ssh-keygen would ask to overwrite.
  for (const k of ["id_ok", "id_ok.pub", "id_bad", "id_bad.pub"]) rmSync(join(dir, k), { force: true });
  for (const k of ["id_ok", "id_bad"]) sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, k)]);
  const name = `claude-ui-e2e-sshd-${process.pid}`;
  sh("docker", ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::22", "-e", `PUBKEY=${readFileSync(join(dir, "id_ok.pub"), "utf8").trim()}`, "debian:bookworm-slim", "sh", "-c", BOOT], 120_000);
  const stop = () => {
    try {
      sh("docker", ["rm", "-f", name], 30_000);
    } catch {
      // Already gone.
    }
  };
  try {
    const port = Number(sh("docker", ["port", name, "22/tcp"]).trim().split(/\r?\n/)[0]!.split(":").pop());
    let keys = "";
    // apt-get and sshd start take a while on a cold image.
    for (let i = 0; i < 90 && !keys; i++) {
      try {
        keys = sh("ssh-keyscan", ["-T", "3", "-p", String(port), "127.0.0.1"], 10_000);
      } catch {
        keys = "";
      }
      if (!keys) await sleep(2_000);
    }
    if (!keys) throw new Error(`sshd in ${name} did not answer on port ${port} within 3 minutes (docker logs ${name})`);
    writeFileSync(join(dir, "known_hosts"), keys);
    writeFileSync(join(dir, "known_hosts_empty"), "");
    for (const k of ["id_ok", "id_bad"]) chmodSync(join(dir, k), 0o600);
    // A port nothing listens on: the container's port + 1 is as good as any, unless taken; ssh then says Connection refused.
    const config = join(dir, "config");
    writeFileSync(config, sshConfigText({ dir, port, closedPort: port === 65535 ? 1 : port + 1 }));
    return { name, port, config, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
