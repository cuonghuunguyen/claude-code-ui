// Claude Code's local settings file (`.claude/settings.local.json`): where the CLI reads it, and a hardened read-modify-write.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

/** A settings file that cannot be read or written; the message names the file. */
export class SettingsFileError extends Error {}

/**
 * Read-modify-write of `<root>/.claude/settings.local.json`: `mutate` gets the parsed object. A symlinked `.claude` that points
 * outside `root`, a file that is not a JSON object, and a write failure throw SettingsFileError. Keeps the file mode; writes a
 * temp file and renames it.
 */
export function updateSettingsFile(root: string, mutate: (settings: Record<string, unknown>) => void): void {
  const dir = join(root, ".claude");
  const file = join(dir, "settings.local.json");
  // A symlinked `.claude` must not take the write out of the project.
  try {
    const rel = relative(realpathSync(root), realpathSync(dir));
    if (rel.startsWith("..") || isAbsolute(rel)) throw new SettingsFileError(`${dir} points outside the project`);
  } catch (e) {
    if (e instanceof SettingsFileError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SettingsFileError(`cannot read ${dir}: ${(e as Error).message}`);
  }
  let mode = 0o644;
  let settings: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SettingsFileError(`${file} is not a JSON object`);
    settings = raw;
    mode = statSync(file).mode & 0o777;
  } catch (e) {
    if (e instanceof SettingsFileError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new SettingsFileError(`cannot read ${file}: ${(e as Error).message}`);
  }
  mutate(settings);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    // "wx": never writes through a path that already exists (a planted symlink).
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { flag: "wx", mode });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new SettingsFileError(`cannot write ${file}: ${(e as Error).message}`);
  }
}

type Env = { platform: NodeJS.Platform; home: string; uid: number | undefined };
const REAL_ENV = (): Env => ({ platform: process.platform, home: homedir(), uid: process.getuid?.() });

function git(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) =>
    execFile("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd, timeout: 10_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim().split("\n")),
    ),
  );
}

const ownedBy = (path: string, uid: number | undefined) => {
  try {
    return statSync(path).uid === uid;
  } catch {
    return true; // absent: nothing to own
  }
};

/**
 * Where Claude Code reads the local settings file of a session in `cwd`: in a git repository the repository root, resolved
 * through a worktree to the main checkout. It uses `<cwd>/.claude/` instead when `cwd` is no repository, on Windows, when the
 * root is the home directory, or when the root, its `.git` or its `.claude` belongs to another user.
 */
export async function localSettingsFile(cwd: string, env: Env = REAL_ENV()): Promise<string> {
  const own = join(cwd, ".claude", "settings.local.json");
  if (env.platform === "win32") return own;
  let main: string;
  try {
    const [top, common] = await git(cwd);
    if (!top || !common) return own;
    main = basename(common) === ".git" ? dirname(common) : top;
  } catch {
    return own;
  }
  if (main === env.home) return own;
  const claude = join(main, ".claude");
  if (![main, join(main, ".git"), ...(existsSync(claude) ? [claude] : [])].every((p) => ownedBy(p, env.uid))) return own;
  return join(claude, "settings.local.json");
}

/** Adds `rule` to `permissions.allow` of `file` (`<root>/.claude/settings.local.json`); no duplicate, other keys kept. */
export function addLocalAllowRule(file: string, rule: string): void {
  updateSettingsFile(dirname(dirname(file)), (settings) => {
    const prev = settings.permissions;
    const permissions: Record<string, unknown> = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    if (!allow.includes(rule)) allow.push(rule);
    permissions.allow = allow;
    settings.permissions = permissions;
  });
}
