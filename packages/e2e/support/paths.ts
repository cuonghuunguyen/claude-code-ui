// Where one run keeps its files. Pure (no Playwright import) so vitest can test it.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `<E2E_SCRATCH or tmp/claude-ui-e2e>/<YYYYMMDD-HHMMSS>-<pid>`; the runner sets E2E_RUN_DIR once, workers inherit it. */
export function runDir(env: NodeJS.ProcessEnv = process.env, now = new Date(), pid = process.pid): string {
  if (env.E2E_RUN_DIR) return env.E2E_RUN_DIR;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(env.E2E_SCRATCH || join(tmpdir(), "claude-ui-e2e"), `${stamp}-${pid}`);
  env.E2E_RUN_DIR = dir;
  return dir;
}

export const configHome = (run: string) => join(run, "ui-config");
export const daemonConfigDir = (run: string) => join(configHome(run), "claude-ui");
/** Windows only: the daemon keeps its uploads under LOCALAPPDATA, so the run gets its own. */
export const localAppData = (run: string) => join(run, "localappdata");
export const projectsRoot = (run: string) => join(run, "projects");
export const evidenceDir = (run: string, env: NodeJS.ProcessEnv = process.env) => env.E2E_EVIDENCE_DIR || join(run, "evidence");

/** A folder-safe lowercase name of at most `max` characters; a cut name ends in a hash of the whole text, so two long names that differ at the end stay apart. */
export function slug(text: string, max = 60): string {
  const full = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  if (full.length <= max) return full;
  const hash = createHash("sha1").update(text).digest("hex").slice(0, 6);
  return `${full.slice(0, max - 7).replace(/-+$/, "")}-${hash}`;
}

/** `<feature file>--<scenario title>` of a running test, as folder-safe parts (the title of an outline row holds its values). */
export function testSlugs(info: { file: string; title: string }): { feature: string; scenario: string } {
  const base = info.file.split(/[\\/]/).pop() ?? "";
  return { feature: slug(base.replace(/\.feature\.spec\.\w+$/, ""), 30), scenario: slug(info.title, 50) };
}
