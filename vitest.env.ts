// Test environment shared by every test file (vitest.config.ts setupFiles): git and shell variables the machine must not decide.
// Test repos must store and read LF on every platform. Git for Windows ships core.autocrlf=true in its system config, which turns every
// file a test writes with "\n" into "\r\n" on checkout. A global config of our own (lower priority than a test repo's own config, so a
// test that sets autocrlf itself still wins) pins it off for the git processes the tests and the code under test start. The user's real
// global config is never read or written.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type * as ChildProcess from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Normally set by vitest.global.ts (inside the run's temp root, removed at the end). A file run without it (an IDE runner) makes its own and removes it on exit.
if (process.env.GIT_CONFIG_GLOBAL === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "vitest-gitcfg-"));
  const file = join(dir, "gitconfig");
  writeFileSync(file, "[core]\n\tautocrlf = false\n");
  process.env.GIT_CONFIG_GLOBAL = file;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
}

// The Claude CLI exports this in its own shells (and so in an agent's): the daemon passes it on to a worker's query only, and a test that
// compares a coordinator's env with a worker's must not inherit it from the shell that runs the suite.
delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR;

// A failing `execFileSync` (the git calls of the test setups) says only "Command failed: <cmd>" when the process left no stderr: it was killed or died at start.
// Status, signal and stderr go into the message, so a failure shows which of the two it was.
// The CommonJS object: the namespace of an ES import cannot be written to.
const cp = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;
const execFileSync = cp.execFileSync;
(cp as { execFileSync: typeof execFileSync }).execFileSync = ((...a: Parameters<typeof execFileSync>) => {
  try {
    return execFileSync(...a);
  } catch (e) {
    const x = e as Error & { status?: number | null; signal?: string | null; stderr?: unknown };
    x.message += ` [status=${x.status} signal=${x.signal} stderr=${String(x.stderr ?? "").slice(0, 300)}]`;
    throw e;
  }
}) as typeof execFileSync;
syncBuiltinESMExports();