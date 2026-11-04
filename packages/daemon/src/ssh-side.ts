// SSH sides (docs/spec.md "Sides"): hosts from ~/.ssh/config, the system `ssh` as transport, install from the Hub's bundle cache over ssh stdin.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SideCheck, SidePhase, SideSetup } from "@claude-ui/protocol";
import { execRun, lastLines, sendBundle, streamTo, type BundleSource, type Exec } from "./docker-side.ts";
import { bundleParts, DOCKER_PROBE, installMethodOf, sideBuild } from "./side-bundle.ts";
import { blockedCheck, checkScript, hasBuild, parseCheck, shq, verdictOf, type SideBundle } from "./sides.ts";

/**
 * The aliases of the `Host` lines: one per token, first occurrence wins. Wildcard (`* ? !`) tokens and tokens that `ssh` would read as an
 * option (leading `-`) or that carry whitespace or control characters are skipped. `Include` is not followed.
 */
export function parseSshConfig(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*host(?:\s*=\s*|\s+)(.*)$/i.exec(raw);
    if (!m) continue;
    // Quoted tokens keep their spaces (then skipped below); an unquoted # starts a comment.
    for (const t of m[1]!.matchAll(/"([^"]*)"|#.*|(\S+)/g)) {
      const a = t[1] ?? t[2];
      if (a && !/[*?!]/.test(a) && !a.startsWith("-") && !/[\s\x00-\x1f\x7f]/.test(a)) out.add(a);
    }
  }
  return [...out];
}

/** The ssh config file the Hub uses instead of ~/.ssh/config: `CLAUDE_UI_SSH_CONFIG` (also passed to every ssh as `-F`); undefined: ssh's own default. */
export const sshConfigPath = (env: NodeJS.ProcessEnv = process.env): string | undefined => env.CLAUDE_UI_SSH_CONFIG || undefined;

/** Host aliases of the ssh config (`config` path, else ~/.ssh/config); [] when there is no file. */
export function listSshHosts(config?: string, read: () => string = () => readFileSync(config ?? join(homedir(), ".ssh", "config"), "utf8")): string[] {
  try {
    return parseSshConfig(read());
  } catch {
    return [];
  }
}

/**
 * `ssh` arguments that run `script` with `sh -c` on the host. No askpass, no password, host key checking as the user configured.
 * Base64 keeps newlines and quotes away from the remote login shell (fish and tcsh break on them).
 */
export const sshArgs = (alias: string, script: string, args: string[] = [], config?: string) => [
  "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", ...(config ? ["-F", config] : []), "--", alias,
  `sh -c ${shq(`eval "$(echo ${Buffer.from(script).toString("base64")} | base64 -d)"`)} sh ${args.map(shq).join(" ")}`.trimEnd(),
];

/** The message for an ssh run that failed in ssh itself (exit 255, or no answer); undefined: the remote command's own exit. */
export function sshError(alias: string, r: { code: number | null; stderr: string }): string | undefined {
  const label = `SSH: ${alias}`;
  if (r.code === null) return `${label} did not answer in time.`;
  if (r.code !== 255) return undefined;
  if (/Permission denied|Too many authentication failures/i.test(r.stderr)) return `${label}: the host refused the login (key or password needed). Run \`ssh ${alias}\` once in a terminal, then retry.`;
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(r.stderr)) return `${label}: the host key is not trusted yet. Run \`ssh ${alias}\` once in a terminal to check and accept it, then retry.`;
  return `${label} is not reachable: ${lastLines(r.stderr).replace(/\.$/, "") || "ssh failed"}.`;
}

/**
 * Before the launch: probes the host's target and streams the bundle (assembled from the Hub's verified parts) through ssh stdin.
 * Resolves with the path on the host and the bundle; rejects with the user's next step. A host the bundle does not cover is an error
 * (the npm fallback comes later). `never`: nothing is probed or sent, only an installed build runs.
 */
export async function prepareSshSide(o: {
  alias: string;
  pkgDir: string;
  key: string;
  setup?: SideSetup;
  pinned?: boolean;
  /** ssh config file (`-F`). */
  config?: string;
  exec?: Exec;
  onPhase?: (p: SidePhase) => void;
  onInstall?: (i: { bundle: true } | { fallback: string }) => void;
  bundle: BundleSource;
}): Promise<{ path: string; bundle?: SideBundle }> {
  const exec = o.exec ?? execRun;
  const label = `SSH: ${o.alias}`;
  if (o.setup === "never") return { path: "" };
  const run = async (script: string, args: string[], ms: number, stdin?: string) => {
    const r = await exec("ssh", sshArgs(o.alias, script, args, o.config), ms, stdin);
    const err = sshError(o.alias, r);
    if (err) throw new Error(err);
    return r;
  };
  const sent = await sendBundle(
    { noun: "host", probe: () => run(DOCKER_PROBE, [], 30_000), send: (file, name) => streamTo((s, a, ms, f) => exec("ssh", sshArgs(o.alias, s, a, o.config), ms, f), label, file, name, "host") },
    { pinned: o.pinned, pkgDir: o.pkgDir, key: o.key, onPhase: o.onPhase, onInstall: o.onInstall },
    o.bundle,
  );
  if ("fallback" in sent) throw new Error(`${label}: this host is not covered by the claude-ui bundle yet (${sent.fallback}).`);
  return sent;
}

/** `side.check` of a host: read-only, one ssh run of the check script. */
export async function checkSshSide(o: { alias: string; config?: string; pkgDir: string; key: string; exec?: Exec; timeoutMs?: number; bundle?: BundleSource }): Promise<SideCheck> {
  const label = `SSH: ${o.alias}`;
  const noun = "host";
  const r = await (o.exec ?? execRun)("ssh", sshArgs(o.alias, checkScript(o.key, "docker"), [], o.config), o.timeoutMs ?? 30_000);
  const err = sshError(o.alias, r);
  if (err) return { ...blockedCheck(o.key, label, "unreachable", { noun }), message: err };
  const checked = parseCheck(r.stdout);
  if (!checked) return blockedCheck(o.key, label, "check_failed", { noun, detail: lastLines(r.stderr).replace(/\.$/, "") || `exit code ${r.code}` });
  const build = sideBuild(o.pkgDir);
  const m = installMethodOf(checked.target, !!build, noun);
  return verdictOf({ key: o.key, label, kind: "wsl", noun, build: hasBuild(o.pkgDir, true), checked, install: m.method === "bundle" ? { method: "bundle", ...(o.bundle && { parts: bundleParts(o.bundle, m, build!.sdkVersion) }) } : m });
}
