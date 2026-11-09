// Test repos must store and read LF on every platform. Git for Windows ships core.autocrlf=true in its system config, which turns every
// file a test writes with "\n" into "\r\n" on checkout. A global config of our own (lower priority than a test repo's own config, so a
// test that sets autocrlf itself still wins) pins it off for the git processes the tests and the code under test start. The user's real
// global config is never read or written.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.GIT_CONFIG_GLOBAL === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "vitest-gitcfg-"));
  const file = join(dir, "gitconfig");
  writeFileSync(file, "[core]\n\tautocrlf = false\n");
  process.env.GIT_CONFIG_GLOBAL = file;
}
