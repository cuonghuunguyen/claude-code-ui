// WSL sides: the host-side step before the setup script runs in the distro (docs/spec.md "Sides"). A distro the bundle covers
// (linux x64/arm64, glibc 2.28+, libstdc++) installs from the same verified parts as a Docker container, read straight from the
// host's cache through /mnt: no npm, no network, no compile in the distro, nothing copied or assembled.
import { join } from "node:path";
import type { SideSetup, SidePhase } from "@claude-ui/protocol";
import { execRun, safeKey, type BundleSource, type Exec } from "./docker-side.ts";
import { claudePackage, ensureParts, installMethodOf, NODE, nodeDirName, parseTarget, partsFor, pruneCache, PTY, sideBuild, TARGET_PROBE } from "./side-bundle.ts";
import type { SideBundle } from "./sides.ts";

/** The target probe in plain sh (no login shell: nothing of the user's profile runs); base64 keeps quotes and newlines off the Windows command line. */
export const probeArgs = (distro: string) => ["-d", distro, "--exec", "sh", "-c", `echo ${Buffer.from(TARGET_PROBE).toString("base64")} | base64 -d | sh`];

/** What the parts are (Node.js, node-pty with its integrity, the SDK, the target): an install made from equal parts has an equal id. */
export const partsIdOf = (target: string, sdkVersion: string) => `node-${NODE.version}|${PTY.name}-${PTY.version}-${PTY.integrity}|sdk-${sdkVersion}|${target}`;

/**
 * Before `wsl.exe` runs the setup script: probes the distro's target and makes the parts present and verified in the host's cache
 * (`downloading`). Resolves with the bundle for `setupScript` (the Windows paths of the cached parts and of `dist/side`), or
 * undefined for npm (`onInstall` says why: a distro the bundle does not cover, a build without dist/side, or parts the host
 * can neither download nor find cached). `never`: nothing is probed or fetched, only an installed build runs.
 */
export async function prepareWslSide(o: {
  distro: string;
  pkgDir: string;
  setup?: SideSetup;
  exec?: Exec;
  onPhase?: (p: SidePhase) => void;
  onInstall?: (i: { bundle: true } | { fallback: string }) => void;
  bundle: BundleSource;
}): Promise<SideBundle | undefined> {
  if (o.setup === "never") return undefined;
  const exec = o.exec ?? execRun;
  const build = sideBuild(o.pkgDir);
  const probe = build ? await exec("wsl.exe", probeArgs(o.distro), 30_000) : undefined;
  const m = installMethodOf(probe ? parseTarget(probe.stdout) : undefined, !!build);
  if (m.method === "npm") return o.onInstall?.({ fallback: m.reason }), undefined;
  const src = o.bundle;
  const version = safeKey(src.version);
  const partsDir = join(src.cacheRoot, version, m.target);
  try {
    await ensureParts({ dir: partsDir, parts: (src.parts ?? partsFor)(m.target, { sdkVersion: build!.sdkVersion }), registry: src.registry, fetch: src.fetch, onDownload: () => o.onPhase?.("downloading") });
  } catch (e) {
    return o.onInstall?.({ fallback: `the host ${(e as Error).message} and has no verified copy of it` }), undefined;
  }
  pruneCache(src.cacheRoot, version);
  o.onInstall?.({ bundle: true });
  return { target: m.target, nodeDir: nodeDirName(m.target), claudePackage: claudePackage(m.target), host: { partsDir, sideDir: build!.dir, version: src.version, partsId: partsIdOf(m.target, build!.sdkVersion) } };
}
