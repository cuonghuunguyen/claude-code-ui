// Checks that a test run leaves nothing in the real temp folder.
//   node scripts/temp-leak.mjs before [snapshot.json]   writes the names now in the temp folder
//   npm test
//   node scripts/temp-leak.mjs after  [snapshot.json]   prints the new names, grouped by prefix; exit 1 when there are any
// The temp folder is the real one (TEMP/TMP/TMPDIR of this shell, not of the run: vitest.global.ts points the run at its own root, removed at the end).
// A name made by another program in the meantime shows up too: read the prefixes (the suite's own are mkdtemp prefixes such as claude-ui-, ocp-, rw-).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, file = join(process.cwd(), "temp-leak-snapshot.json")] = process.argv.slice(2);
const dir = tmpdir();
const names = readdirSync(dir);

if (mode === "before") {
  writeFileSync(file, JSON.stringify(names));
  console.log(`${names.length} entries in ${dir}`);
} else if (mode === "after") {
  const before = new Set(JSON.parse(readFileSync(file, "utf8")));
  const fresh = names.filter((n) => !before.has(n));
  const groups = new Map();
  for (const n of fresh) {
    const k = /^[A-Za-z]+[-_]/.exec(n)?.[0] ?? "(other)";
    groups.set(k, [...(groups.get(k) ?? []), n]);
  }
  console.log(`${names.length} entries in ${dir}, ${fresh.length} new`);
  for (const [k, v] of [...groups].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${v.length} ${k}  e.g. ${v.slice(0, 3).join(", ")}`);
  process.exitCode = fresh.length ? 1 : 0;
} else {
  console.error("usage: node scripts/temp-leak.mjs before|after [snapshot.json]");
  process.exitCode = 2;
}
