// Docker sides (docs/spec.md "Sides"): discovery of running Linux containers and the copy of this claude-ui's package into one.
import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { runCommand, type Runner } from "./update.ts";

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

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Container names from `docker ps --format {{.Names}}`: the first name of each line; Kubernetes pod containers (k8s_*) are no user side. */
export function parseContainers(out: string): string[] {
  const names = out
    .split(/\r?\n/)
    .map((l) => l.trim().split(",")[0]!.trim())
    .filter((n) => NAME.test(n) && !n.startsWith("k8s_"));
  return [...new Set(names)];
}

/** Running Linux containers; [] when the CLI is missing, the engine is down or runs Windows containers. */
export async function listContainers(exec: Exec = execRun): Promise<string[]> {
  const v = await exec("docker", ["version", "--format", "{{.Server.Os}}"], 10_000);
  if (v.code !== 0 || v.stdout.trim() !== "linux") return [];
  const ps = await exec("docker", ["ps", "--filter", "status=running", "--format", "{{.Names}}"], 10_000);
  return ps.code === 0 ? parseContainers(ps.stdout) : [];
}

const lastLines = (s: string, n = 1) => s.trim().split(/\r?\n/).slice(-n).join(" ").trim();
const WAIT = "If a build is running, wait for the build to finish, then retry.";
/** The file npm could not read: its `path` line, else the quoted path after "no such file or directory". */
export function missingFile(output: string): string | undefined {
  if (!/enoent|no such file/i.test(output)) return undefined;
  return /^npm error path (.+)$/m.exec(output)?.[1]?.trim() ?? /no such file or directory, \w+ '([^'\n]+)'/.exec(output)?.[1];
}
export const safeKey = (key: string) => key.replace(/[^\w.-]/g, "_");
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
    throw new Error(`Packing claude-ui for ${o.label} failed: ${lastLines(output, 8) || `npm exited with ${code}`}${gone ? ` (missing: ${gone}). A build may be rewriting dist: wait for the build to finish, then retry.` : ""}`);
  }
  // Earlier versions and builds.
  for (const n of readdirSync(o.cacheDir)) if (n !== basename(partial)) rmSync(join(o.cacheDir, n), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  renameSync(partial, dir);
  return join(dir, file);
}

/**
 * Before `docker exec`: the container must run; this claude-ui's package goes in as a tarball. Resolves with the tarball's
 * path in the container; rejects with the user's next step (the side shows it, side_failed).
 */
export async function prepareDockerSide(o: { name: string; pkgDir: string; key: string; cacheDir: string; exec?: Exec; npm?: Runner }): Promise<string> {
  const exec = o.exec ?? execRun;
  const label = `Docker: ${o.name}`;
  const st = await exec("docker", ["inspect", "-f", "{{.State.Running}}", o.name], 10_000);
  if (st.code !== 0) throw new Error(/no such (object|container)/i.test(st.stderr) ? `${label} no longer exists. Pick another container.` : `${label} could not be checked: ${lastLines(st.stderr) || "docker inspect failed"}.`);
  if (st.stdout.trim() !== "true") throw new Error(`${label} is not running. Start it (docker start ${o.name}), then retry.`);
  mkdirSync(o.cacheDir, { recursive: true });
  const tgz = await packSide({ pkgDir: o.pkgDir, key: o.key, cacheDir: o.cacheDir, label, npm: o.npm });
  return sendTarball(exec, o.name, label, tgz, `claude-ui-side-${safeKey(o.key)}.tgz`);
}

/** Directories tried in order; "HOME" is the container user's $HOME. */
const DEST_DIRS = ["/tmp", "/dev/shm", "HOME"];
const COPY_SCRIPT = 'd=$1; if [ "$d" = HOME ]; then d=$HOME; fi; [ -n "$d" ] || exit 3; f="$d/$2"; cat > "$f" || { rm -f "$f"; exit 1; }; echo "$f"';

/**
 * `docker cp` prepares the container's mounts, so it fails on a read-only root file system or read-only bind mounts even for
 * /tmp. The tarball is fed to `docker exec -i <name> sh -c 'cat > <dest>'` instead (a tmpfs /tmp or /dev/shm is writable there).
 * Resolves with the path that took it.
 */
async function sendTarball(exec: Exec, name: string, label: string, tgz: string, file: string): Promise<string> {
  const errors: string[] = [];
  for (const d of DEST_DIRS) {
    const r = await exec("docker", ["exec", "-i", name, "sh", "-c", COPY_SCRIPT, "sh", d, file], 120_000, tgz);
    const path = r.stdout.trim().split(/\r?\n/).pop() ?? "";
    if (r.code === 0 && path) return path;
    errors.push(lastLines(r.stderr) || `exit code ${r.code}`);
  }
  const tried = DEST_DIRS.map((d) => (d === "HOME" ? "$HOME" : d)).join(", ");
  const why = errors.every((e) => /read-only file system/i.test(e)) ? "the container's file system is read-only (no writable /tmp, /dev/shm or home); mount a tmpfs on /tmp (docker run --tmpfs /tmp)" : errors[0]!;
  throw new Error(`Copying claude-ui into ${label} failed: no writable path (tried ${tried}): ${why.replace(/\.$/, "")}.`);
}
