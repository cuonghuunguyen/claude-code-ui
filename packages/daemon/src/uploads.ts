// fs.upload storage: one private folder per session under a stable parent (docs/spec.md "Uploads").
import { DRAFT_TOKEN } from "@claude-ui/protocol";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, win32 } from "node:path";
import { configDir } from "./token.ts";

/** A session id as a folder name: lowercase only (Windows and macOS file systems ignore case). */
export const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DRAFT_TTL_MS = 24 * 3600_000;
export const ORPHAN_AGE_MS = 24 * 3600_000;
export const MAX_DRAFTS = 1000;

/** Default parent: %LOCALAPPDATA%\claude-ui\uploads on Windows (configDir()/uploads without it), configDir()/uploads elsewhere. */
export function defaultUploadsDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, config: string = configDir(env, platform)): string {
  return platform === "win32" && env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, "claude-ui", "uploads") : join(config, "uploads");
}

type Draft = { id: string; at: number; claimed: boolean };

export function createUploads(o: { dir?: string; now?: () => number; uid?: number | undefined } = {}) {
  const now = o.now ?? Date.now;
  const uid = "uid" in o ? o.uid : process.getuid?.();

  /** A directory made by us: not a symlink, ours, 0700. Throws otherwise. */
  const verify = (path: string) => {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`not a plain directory: ${path}`);
    if (uid !== undefined && st.uid !== uid) throw new Error(`not owned by this user: ${path}`);
    chmodSync(path, 0o700);
  };
  const open = (dir: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    verify(dir);
    return dir;
  };
  const parent = (() => {
    if (o.dir === undefined) return mkdtempSync(join(tmpdir(), "claude-ui-"));
    try {
      return open(o.dir);
    } catch (e) {
      console.error(`uploads: ${o.dir} is not usable, using a temporary folder:`, e);
      return mkdtempSync(join(tmpdir(), "claude-ui-"));
    }
  })();

  const check = (id: string) => {
    if (typeof id !== "string" || !SESSION_DIR.test(id)) throw new Error("invalid session id");
    return join(parent, id);
  };
  const drafts = new Map<string, Draft>();
  const expired = (d: Draft) => now() - d.at > DRAFT_TTL_MS;

  return {
    parent,
    /** <parent>/<id>, created and verified 0700; throws on a bad id or a folder that is not ours. */
    dirFor(id: string): string {
      const dir = check(id);
      try {
        mkdirSync(dir, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      verify(dir);
      return dir;
    },
    /** Writes `data` as <parent>/<id>/u-XXXXXX/<name> (0600); returns the path. */
    store(id: string, name: string, data: Buffer): string {
      const dir = this.dirFor(id);
      // basename: the name must not climb out of the upload folder.
      const file = join(mkdtempSync(join(dir, "u-")), basename(name).replace(/^\.+/, "") || "file");
      writeFileSync(file, data, { mode: 0o600 });
      return file;
    },
    /** The id behind a draft token, made on first use. Synchronous: concurrent uploads of one attach share the id. */
    ownerOfDraft(token: string): string | undefined {
      if (typeof token !== "string" || !DRAFT_TOKEN.test(token)) return undefined;
      const t = now();
      const d = drafts.get(token);
      // A claimed token is spent: the session has an id of its own to upload with (a copy of the token must not reach its folder).
      if (d?.claimed && !expired(d)) return undefined;
      if (d && !expired(d)) {
        d.at = t;
        return d.id;
      }
      drafts.delete(token);
      if (drafts.size >= MAX_DRAFTS) {
        let oldest: string | undefined;
        for (const [k, v] of drafts) if (oldest === undefined || v.at < drafts.get(oldest)!.at) oldest = k;
        if (oldest !== undefined) drafts.delete(oldest);
      }
      const id = randomUUID();
      drafts.set(token, { id, at: t, claimed: false });
      return id;
    },
    /** One claim per token: the id of its uploads, for the session that is being created. */
    claim(token: string): string | undefined {
      if (typeof token !== "string" || !DRAFT_TOKEN.test(token)) return undefined;
      const d = drafts.get(token);
      if (!d || d.claimed || expired(d)) return undefined;
      d.claimed = true;
      d.at = now();
      return d.id;
    },
    draftClaimed(token: string): boolean {
      const d = drafts.get(token);
      return !!d?.claimed && !expired(d);
    },
    hasDraftId(id: string): boolean {
      for (const d of drafts.values()) if (d.id === id) return true;
      return false;
    },
    /** Deletes <parent>/<id> (a symlink there: only the link). Never touches anything outside the parent. */
    async remove(id: string): Promise<void> {
      if (typeof id !== "string" || !SESSION_DIR.test(id)) return;
      for (const [k, d] of drafts) if (d.id === id) drafts.delete(k);
      const dir = join(parent, id);
      const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
      if (!st) return;
      if (st.isSymbolicLink() || !st.isDirectory()) await unlink(dir);
      else await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    },
    /** Removes folders of no known session that nothing wrote to for ORPHAN_AGE_MS; returns their ids. */
    async sweep(known: (id: string) => boolean | Promise<boolean>): Promise<string[]> {
      const removed: string[] = [];
      for (const name of readdirSync(parent)) {
        try {
          if (!SESSION_DIR.test(name)) continue;
          const dir = join(parent, name);
          const st = await lstat(dir);
          if (st.isSymbolicLink() || !st.isDirectory()) {
            await unlink(dir);
            continue;
          }
          if (await known(name)) continue;
          let newest = st.mtimeMs;
          for (const c of await readdir(dir)) if (c.startsWith("u-")) newest = Math.max(newest, (await lstat(join(dir, c))).mtimeMs);
          if (now() - newest < ORPHAN_AGE_MS) continue;
          await this.remove(name);
          removed.push(name);
        } catch (e) {
          console.error(`uploads: sweep of ${name} failed:`, e);
        }
      }
      return removed;
    },
  };
}
