// Runs once per `vitest run` (vitest.config.ts globalSetup): every test, the code under test and the processes they start get one run-scoped temp root, removed at the end.
// Why: tests make their folders with mkdtemp(os.tmpdir()) and only some delete them (28 of 98 files); 50k folders a day piled up in the user's %TEMP%.
// os.tmpdir() reads TEMP/TMP (Windows) or TMPDIR (POSIX) on every call, and workers and child processes (git, the fake OpenCode, daemons) inherit the environment of
// this process, set before the first worker starts: a test that needs no path outside the root changes nothing.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Removes `dir` recursively; a file a dying child still holds (Windows) is retried, then named. */
function removeRoot(dir: string): string[] {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    return [];
  } catch (e) {
    const left: string[] = [];
    const walk = (d: string) => {
      try {
        for (const f of readdirSync(d, { withFileTypes: true })) (f.isDirectory() ? walk : (p: string) => left.push(p))(join(d, f.name));
      } catch {
        left.push(d);
      }
    };
    walk(dir);
    console.error(`[vitest-run] could not remove ${dir}: ${(e as Error).message}. Left: ${left.slice(0, 20).join(", ")}${left.length > 20 ? ` … (${left.length})` : ""}`);
    return left;
  }
}

export default function setup() {
  const real = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const root = mkdtempSync(join(tmpdir(), "vitest-run-"));
  mkdirSync(root, { recursive: true });
  // The git config the tests run with (see vitest.env.ts): one file for the run.
  const gitConfig = join(root, "gitconfig");
  writeFileSync(gitConfig, "[core]\n\tautocrlf = false\n");
  process.env.GIT_CONFIG_GLOBAL ??= gitConfig;
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
  // For a check outside the run (scripts/temp-leak.mjs) and the few tests that must see the real folder.
  process.env.VITEST_REAL_TMPDIR = real.TEMP ?? real.TMP ?? real.TMPDIR ?? tmpdir();
  return () => {
    Object.assign(process.env, Object.fromEntries(Object.entries(real).filter(([, v]) => v !== undefined)));
    removeRoot(root);
  };
}
