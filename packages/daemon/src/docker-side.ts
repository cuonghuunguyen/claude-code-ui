// Docker sides (docs/spec.md "Sides"): discovery of running Linux containers and the copy of this claude-ui's package into one.
import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DockerState, SideCheck, SideCheckReason, SidePhase, SideSetup } from "@claude-ui/protocol";
import { blockedCheck, checkScript, dockerExecArgs, hasBuild, parseCheck, verdictOf, type SideBundle } from "./sides.ts";
import { assembleBundle, claudePackage, DOCKER_PROBE, ensureParts, bundleParts, markUsed, nodeDirName, parseTarget, partsFor, installMethodOf, probeFailReason, pruneCache, removeStale, safeKey, sideBuild } from "./side-bundle.ts";
import { runCommand, type Runner } from "./update.ts";
export { installMethodOf };

/** Runs a command without a shell; never rejects. `code` null: not started (ENOENT) or killed by the timeout. `stdinFile`: that file is the command's stdin. */
export type Exec = (cmd: string, args: string[], timeoutMs?: number, stdinFile?: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
export const execRun: Exec = (cmd, args, timeoutMs = 10_000, stdinFile) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: "utf8", maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as unknown as { code: number }).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err && code === null ? err.message : "") });
    });
    if (stdinFile) {
      const src = createReadStream(stdinFile);
      src.on("error", () => child.kill());
      child.stdin?.on("error", () => {}); // the command ended before reading it all: its exit code says why
      src.pipe(child.stdin!);
    }
  });

/** A folder URL as a path without a trailing separator: `npm pack <dir>\` through cmd.exe loses its closing quote. */
export const folderPath = (url: URL) => resolve(fileURLToPath(url));

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Container names from `docker ps --format {{.Names}}`: the first name of each line; Kubernetes pod containers (k8s_*) are no user side. */
export function parseContainers(out: string): string[] {
  const names = out
    .split(/\r?\n/)
    .map((l) => l.trim().split(",")[0]!.trim())
    .filter((n) => NAME.test(n) && !n.startsWith("k8s_"));
  return [...new Set(names)];
}

/**
 * What a hub with the docker command sees (`ListResult.docker`): `down` = the engine does not answer (or runs Windows containers),
 * `empty` = the engine runs no Linux container of ours, `ok` = at least one. `containers`: their names.
 */
export async function dockerStatus(exec: Exec = execRun): Promise<{ state: DockerState; containers: string[] }> {
  const v = await exec("docker", ["version", "--format", "{{.Server.Os}}"], 10_000);
  if (v.code !== 0 || v.stdout.trim() !== "linux") return { state: "down", containers: [] };
  const ps = await exec("docker", ["ps", "--filter", "status=running", "--format", "{{.Names}}"], 10_000);
  if (ps.code !== 0) return { state: "down", containers: [] };
  const containers = parseContainers(ps.stdout);
  return { state: containers.length ? "ok" : "empty", containers };
}

/** Running Linux containers; [] when the CLI is missing, the engine is down or runs Windows containers. */
export async function listContainers(exec: Exec = execRun): Promise<string[]> {
  return (await dockerStatus(exec)).containers;
}

const lastLines = (s: string, n = 1) => s.trim().split(/\r?\n/).slice(-n).join(" ").trim();
const WAIT = "If a build is running, wait for the build to finish, then retry.";
/** The file npm could not read: its `path` line, else the quoted path after "no such file or directory". */
export function missingFile(output: string): string | undefined {
  if (!/enoent|no such file/i.test(output)) return undefined;
  return /^npm error path (.+)$/m.exec(output)?.[1]?.trim() ?? /no such file or directory, \w+ '([^'\n]+)'/.exec(output)?.[1];
}
/** True when `file` lies inside `<pkgDir>/dist`: only then is a missing file a build rewriting dist (a bad argument is not). */
export function underDist(file: string, pkgDir: string): boolean {
  const rel = relative(resolve(pkgDir, "dist"), resolve(file));
  return rel !== "" && !rel.startsWith("..") && resolve(rel) !== rel;
}
export { safeKey };
const packing = new Map<string, Promise<string>>();

/** This claude-ui's package as an npm tarball, packed once per key into `<cacheDir>/<key>/`; other keys are removed. */
export function packSide(o: { pkgDir: string; key: string; cacheDir: string; label: string; npm?: Runner }): Promise<string> {
  const dir = join(o.cacheDir, safeKey(o.key));
  const running = packing.get(dir);
  if (running) return running;
  const p = pack(o, dir).finally(() => packing.delete(dir));
  packing.set(dir, p);
  return p;
}

async function pack(o: { pkgDir: string; cacheDir: string; label: string; npm?: Runner }, dir: string): Promise<string> {
  const cached = existsSync(dir) && readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (cached) return join(dir, cached);
  const missing = ["cli.js", "web"].filter((f) => !existsSync(join(o.pkgDir, "dist", f === "web" ? "web/index.html" : f)));
  if (missing.length) throw new Error(`${o.label} could not start: this claude-ui has no complete build (missing dist/${missing.join(", dist/")}). ${WAIT} Otherwise run npm start (it builds it), then retry.`);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const { code, output } = await (o.npm ?? runCommand)("npm", ["pack", o.pkgDir, "--ignore-scripts", "--pack-destination", partial, "--loglevel=error"]);
  const file = readdirSync(partial).find((f) => f.endsWith(".tgz"));
  if (code !== 0 || !file) {
    rmSync(partial, { recursive: true, force: true });
    const gone = missingFile(output);
    const hint = gone ? (underDist(gone, o.pkgDir) ? ` (missing: ${gone}). A build may be rewriting dist: wait for the build to finish, then retry.` : ` (missing: ${gone})`) : "";
    throw new Error(`Packing claude-ui for ${o.label} failed: ${lastLines(output, 8) || `npm exited with ${code}`}${hint}`);
  }
  // Earlier versions and builds.
  for (const n of readdirSync(o.cacheDir)) if (n !== basename(partial)) rmSync(join(o.cacheDir, n), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  renameSync(partial, dir);
  return join(dir, file);
}

/** Where and how the hub gets the bundle parts (side-bundle.ts). */
export type BundleSource = { cacheRoot: string; version: string; registry?: string; fetch?: typeof fetch; /** Test seam: the parts to fetch. */ parts?: typeof partsFor };

/**
 * Before `docker exec`: the container must run; this claude-ui goes in as one file. Covered containers (linux x64/arm64, glibc
 * 2.28+, libstdc++) get the host-assembled bundle: parts verified or downloaded (`downloading`), assembled (`packing`), copied.
 * Any other container, a build without dist/side, or parts the host can neither download nor find cached: the npm tarball
 * (`install` says which and why). Resolves with the file's path in the container and the bundle (undefined: npm); rejects
 * with the user's next step (the side shows it, side_failed).
 */
export async function prepareDockerSide(o: {
  name: string;
  pkgDir: string;
  key: string;
  cacheDir: string;
  exec?: Exec;
  npm?: Runner;
  setup?: SideSetup;
  /** Use the pinned Node.js although the container has one (the found one did not start claude-ui). */
  pinned?: boolean;
  onPhase?: (p: SidePhase) => void;
  onInstall?: (i: { bundle: true } | { fallback: string }) => void;
  bundle?: BundleSource;
}): Promise<{ path: string; bundle?: SideBundle }> {
  const exec = o.exec ?? execRun;
  const label = `Docker: ${o.name}`;
  const st = await exec("docker", ["inspect", "-f", "{{.State.Running}}", o.name], 10_000);
  if (st.code !== 0) throw new Error(/no such (object|container)/i.test(st.stderr) ? `${label} no longer exists. Pick another container.` : `${label} could not be checked: ${lastLines(st.stderr) || "docker inspect failed"}.`);
  if (st.stdout.trim() !== "true") throw new Error(`${label} is not running. Start it (docker start ${o.name}), then retry.`);
  // never: only an installed build runs, so nothing is packed or copied ("" : the setup script does not use a tarball).
  if (o.setup === "never") return { path: "" };
  if (o.bundle) {
    const sent = await sendBundle(exec, o, o.bundle, label);
    if ("path" in sent) return sent;
    o.onInstall?.({ fallback: sent.fallback });
  }
  o.onPhase?.("packing");
  mkdirSync(o.cacheDir, { recursive: true });
  const tgz = await packSide({ pkgDir: o.pkgDir, key: o.key, cacheDir: o.cacheDir, label, npm: o.npm });
  o.onPhase?.("copying");
  return { path: await sendTarball(exec, o.name, label, tgz, `claude-ui-side-${safeKey(o.key)}.tgz`) };
}

/** The bundle path of prepareDockerSide: `{fallback}` when the container is not covered or the parts cannot be had (the npm path follows). */
async function sendBundle(exec: Exec, o: { pinned?: boolean; name: string; pkgDir: string; key: string; onPhase?: (p: SidePhase) => void; onInstall?: (i: { bundle: true }) => void }, src: BundleSource, label: string): Promise<{ path: string; bundle: SideBundle } | { fallback: string }> {
  const build = sideBuild(o.pkgDir);
  const probe = build ? await exec("docker", ["exec", o.name, "sh", "-c", DOCKER_PROBE], 15_000) : undefined;
  const target = probe ? parseTarget(probe.stdout) : undefined;
  // docker exec did not run the probe (timeout, a failed exec): not a container the bundle does not cover.
  if (probe && !target) return { fallback: probeFailReason(probe, "container") };
  const m = installMethodOf(target, !!build);
  if (m.method === "npm") return { fallback: m.reason };
  if (o.pinned) m.node = "pinned";
  const version = safeKey(src.version);
  const dir = join(src.cacheRoot, version, m.target);
  let parts: Record<string, string>;
  try {
    parts = await ensureParts({ dir, parts: (src.parts ?? partsFor)(m.target, { sdkVersion: build!.sdkVersion, node: m.node }), registry: src.registry, fetch: src.fetch, onDownload: () => o.onPhase?.("downloading") });
  } catch (e) {
    return { fallback: (e as Error).message };
  }
  markUsed(src.cacheRoot, version);
  pruneCache(src.cacheRoot, version);
  o.onInstall?.({ bundle: true });
  o.onPhase?.("packing");
  const outDir = join(src.cacheRoot, version, ".tmp");
  // Tars of a crashed start (a live start deletes its own tar after the copy).
  removeStale(outDir, "bundle-", 3_600_000);
  const tar = await assembleBundle({ partFiles: parts, sideDir: build!.dir, version: src.version, outDir });
  try {
    o.onPhase?.("copying");
    const path = await sendTarball(exec, o.name, label, tar, `claude-ui-side-${safeKey(o.key)}.tar`);
    return { path, bundle: { target: m.target, ...(m.node === "pinned" && { nodeDir: nodeDirName(m.target) }), claudePackage: claudePackage(m.target) } };
  } finally {
    rmSync(tar, { force: true });
  }
}

/**
 * `side.check` of a container: read-only. `docker inspect` (running?), the mounts inspect (can `docker cp` write /tmp), then one
 * `docker exec <name> sh -c <check script>`. Never packs, copies or writes; the inspect formats never print the environment.
 * Whether the package gets in by `docker cp` or by a stream is not told: it only matters that one of them can (else `no_writable_path`).
 */
export async function checkDockerSide(o: { name: string; pkgDir: string; key: string; exec?: Exec; timeoutMs?: number; bundle?: BundleSource }): Promise<SideCheck> {
  // The install method follows the container's target and whether this build has dist/side (the bundle's JS).
  const exec = o.exec ?? execRun;
  const label = `Docker: ${o.name}`;
  const ms = o.timeoutMs ?? 30_000;
  const blocked = (reason: SideCheckReason, detail?: string, running?: boolean) => blockedCheck(o.key, label, reason, { docker: true, detail, name: o.name, reachable: reason !== "unreachable" && reason !== "gone", running });
  const st = await exec("docker", ["inspect", "-f", "{{.State.Running}}", o.name], 10_000);
  if (st.code !== 0) {
    if (/no such (object|container)/i.test(st.stderr)) return blocked("gone");
    return blocked("unreachable", lastLines(st.stderr).replace(/\.$/, "") || (st.code === null ? "no answer in time" : "docker inspect failed"));
  }
  if (st.stdout.trim() !== "true") return blocked("not_running", undefined, false);
  const ins = await exec("docker", ["inspect", "-f", INSPECT_FORMAT, o.name], 10_000);
  const cp = ins.code === 0 ? cpUsable(ins.stdout) : undefined;
  const net = await exec("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", o.name], 10_000);
  const network = net.code === 0 && net.stdout.trim() ? net.stdout.trim() !== "none" : undefined;
  const r = await exec("docker", dockerExecArgs(o.name, checkScript(o.key, "docker")).filter((a) => a !== "-i"), ms);
  const checked = parseCheck(r.stdout);
  if (!checked) return blocked(r.code === null ? "unreachable" : "check_failed", r.code === null ? "no answer in time" : lastLines(r.stderr).replace(/\.$/, "") || `exit code ${r.code}`, true);
  const m = installMethodOf(checked.target, !!sideBuild(o.pkgDir));
  return verdictOf({ key: o.key, label, kind: "docker", name: o.name, build: hasBuild(o.pkgDir, true), checked, cpUsable: cp, install: m.method === "bundle" ? { method: "bundle", ...(o.bundle && { parts: bundleParts(o.bundle, m, sideBuild(o.pkgDir)!.sdkVersion) }) } : m, network });
}

/** Directories tried in order; "HOME" is the container user's $HOME. */
const DEST_DIRS = ["/tmp", "/dev/shm", "HOME"];
const CP_DIR = "/tmp";
/** $1 dir, $2 file name, $3 expected size: a stream cut off midway (size differs) is removed, never installed. */
const COPY_SCRIPT =
  'd=$1; if [ "$d" = HOME ]; then d=$HOME; fi; [ -n "$d" ] || exit 3; f="$d/$2"; cat > "$f" || { rm -f "$f"; exit 1; }; n=$(wc -c < "$f" | tr -d " \t"); if [ "$n" != "$3" ]; then rm -f "$f"; echo "size mismatch: wrote ${n:-?} of $3 bytes to $f" >&2; exit 4; fi; echo "$f"';
const INSPECT_FORMAT = '{{.HostConfig.ReadonlyRootfs}}{{"\n"}}{{range .Mounts}}{{.Destination}} {{.RW}}{{"\n"}}{{end}}{{json .HostConfig.Tmpfs}}';

/** Whether `docker cp` can write CP_DIR: from the inspect output (read-only root, mounts as `<dest> <rw>` lines, the tmpfs map as JSON on the last line). undefined: not parseable. */
export function cpUsable(out: string): boolean | undefined {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const root = lines[0];
  if ((root !== "true" && root !== "false") || lines.length < 2) return undefined;
  if (root === "true") return false;
  const under = (p: string) => p === CP_DIR || CP_DIR.startsWith(p.replace(/\/+$/, "") + "/");
  for (const l of lines.slice(1, -1)) {
    const i = l.lastIndexOf(" ");
    if (i < 0) return undefined;
    if (l.slice(i + 1) !== "true" || under(l.slice(0, i))) return false;
  }
  try {
    const tmpfs = JSON.parse(lines[lines.length - 1]!) as Record<string, string> | null;
    if (tmpfs && Object.keys(tmpfs).some(under)) return false;
  } catch {
    return undefined;
  }
  return true;
}

/**
 * `docker cp` first when the container allows it (root and mounts writable, /tmp on the plain root file system): it fails
 * on a read-only root file system, read-only mounts and tmpfs /tmp. Otherwise, or when the cp fails, the tarball is fed to
 * `docker exec -i <name> sh -c 'cat > <dest>'` (a tmpfs /tmp or /dev/shm is writable there) and its size is checked.
 * Resolves with the path that took it.
 */
async function sendTarball(exec: Exec, name: string, label: string, tgz: string, file: string): Promise<string> {
  let cpError = "";
  const ins = await exec("docker", ["inspect", "-f", INSPECT_FORMAT, name], 10_000);
  if (ins.code !== 0 || cpUsable(ins.stdout) !== false) {
    const dest = `${CP_DIR}/${file}`;
    const cp = await exec("docker", ["cp", tgz, `${name}:${dest}`], 120_000);
    if (cp.code === 0) return dest;
    cpError = lastLines(cp.stderr) || `exit code ${cp.code}`;
  }
  const size = String(statSync(tgz).size);
  const errors: string[] = [];
  for (const d of DEST_DIRS) {
    const r = await exec("docker", ["exec", "-i", name, "sh", "-c", COPY_SCRIPT, "sh", d, file, size], 120_000, tgz);
    const path = r.stdout.trim().split(/\r?\n/).pop() ?? "";
    if (r.code === 0 && path) return path;
    errors.push(lastLines(r.stderr) || `exit code ${r.code}`);
  }
  const tried = DEST_DIRS.map((d) => (d === "HOME" ? "$HOME" : d)).join(", ");
  const why = errors.every((e) => /read-only file system/i.test(e)) ? "the container's file system is read-only (no writable /tmp, /dev/shm or home); mount a tmpfs on /tmp (docker run --tmpfs /tmp)" : errors[0]!;
  const first = cpError ? `docker cp was tried first and failed (${cpError.replace(/\.$/, "")}); then docker exec: ` : "";
  throw new Error(`Copying claude-ui into ${label} failed: ${first}no writable path (tried ${tried}): ${why.replace(/\.$/, "")}.`);
}
