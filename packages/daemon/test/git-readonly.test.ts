import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitReadOnly } from "../src/git-readonly.ts";
import { tier } from "../src/risk-tier.ts";

// No symlinks here: this file runs on Windows too (risk-tier.test.ts holds the symlink rows).
const root = realpathSync(mkdtempSync(join(tmpdir(), "gro-")));
const cwd = join(root, "repo");
const bare = join(root, "norepo");
for (const d of ["src", ".git", ".claude/skills/x", bare]) mkdirSync(d.startsWith(root) ? d : join(cwd, d), { recursive: true });
for (const f of ["src/a.ts", ".env", "CLAUDE.md", ".claude/settings.json", ".claude/skills/x/SKILL.md"]) writeFileSync(join(cwd, f), "x");

const low = [
  "git status",
  "git status -sb",
  "git status --short",
  "git status --porcelain=v2",
  "git --no-pager log",
  "git --no-optional-locks status",
  "git log --oneline -3",
  "git log --oneline -n 5",
  "git log -n5",
  // The incident of GH-163.
  "git log --oneline -3; git status --short",
  "git status && git log -1",
  "git status || git log -1",
  "git diff",
  "git diff --stat",
  "git diff --cached",
  "git diff HEAD~1 -- src",
  "git diff main...HEAD",
  "git log main..HEAD --oneline",
  "git log --format=%h",
  "git log --pretty=format:%h%x20%s",
  "git log --since=2.weeks --author=bob",
  "git show HEAD",
  "git show HEAD^:src/a.ts",
  "git show HEAD:CLAUDE.md",
  "git show @{u}",
  "git log HEAD@{1}",
  "git diff src/a.ts",
  "git diff -- .claude/skills/x/SKILL.md",
  "git branch --show-current",
  "git rev-parse --abbrev-ref HEAD",
  "git rev-parse --show-toplevel",
];

const high = [
  // Other programs and chains.
  "git status; rm -rf ~",
  "git status && curl x",
  "git status | sh",
  "git log | head",
  "git status &",
  "git status;",
  "ls",
  "npm test",
  "npx tsc",
  "git status; git status; git status; git status; git status; git status",
  // Expansion and quoting.
  "git log $(id)",
  "git log `id`",
  "git log 'a b'",
  'git log "a"',
  "git log a\\ b",
  "git log *",
  "git log {a,b}",
  "git log HEAD@{1..3}",
  "git log ~",
  "git log ~/x",
  "git diff --stat=~",
  "git log !1",
  "git status #c",
  "git log ${HOME}",
  // Whitespace and encoding.
  "git status\n",
  "git status\nrm x",
  "\tgit status",
  "git status\trm",
  "git \u0455tatus",
  "git sta\u200btus",
  // Redirection.
  "git diff > out.txt",
  "git diff < in",
  "git diff 2>&1",
  "git diff >/dev/null",
  // Program path and environment.
  "/usr/bin/git status",
  "./git status",
  "gitx status",
  "FOO=1 git status",
  "env git status",
  "command git status",
  // Global options.
  "git -c core.pager=sh status",
  "git -c core.fsmonitor=x status",
  "git -C .. status",
  "git -C . status",
  "git --git-dir=x status",
  "git --work-tree=/ status",
  "git --exec-path=. status",
  "git -p log",
  "git --paginate log",
  "git --config-env=a=b status",
  "git --namespace=x log",
  // Dangerous options, also abbreviated.
  "git diff --output=/tmp/x",
  "git diff --out=x",
  "git log --output=x",
  "git diff --ext-diff",
  "git diff --ext",
  "git log --textconv",
  "git show --textc",
  "git diff --no-index /etc/passwd x",
  "git log --show-signature",
  "git log --format=%GS",
  "git log --pretty=%G?",
  "git diff -O/etc/passwd",
  "git log --stdin",
  "git log --remerge-diff",
  // Paths.
  "git show /etc/passwd",
  "git diff /dev/null src/a.ts",
  "git diff C:/x",
  "git show HEAD:../../x/../y",
  "git diff -- ../o",
  "git diff ..",
  "git show HEAD:.env",
  "git diff .env",
  "git diff -- .git/config",
  "git show HEAD:.claude/settings.json",
  "git diff .claude/settings.json",
  "git log -- :/",
  // Write and other subcommands.
  "git add .",
  "git commit -m m",
  "git push",
  "git checkout .",
  "git stash",
  "git branch",
  "git branch -D main",
  "git branch --show-current x",
  "git config core.fsmonitor x",
  "git grep x",
  "git format-patch -1",
  "git difftool",
  "git st",
  "git",
  "git log -n",
  "git log -n x",
  "git rev-parse --git-path hooks",
  "git rev-parse --parseopt",
  "git rev-parse",
];

describe("gitReadOnly", () => {
  it.each(low)("low: %s", (command) => expect(gitReadOnly({ command }, cwd)).toBe(true));
  it.each(high)("high: %j", (command) => expect(gitReadOnly({ command }, cwd)).toBe(false));

  it("an input that is not a plain command is refused", () => {
    expect(gitReadOnly({ command: 1 }, cwd)).toBe(false);
    expect(gitReadOnly({ command: "git status", run_in_background: true }, cwd)).toBe(false);
    expect(gitReadOnly({ command: "git status", dangerouslyDisableSandbox: true }, cwd)).toBe(false);
    expect(gitReadOnly({ command: "git status", extra: 1 }, cwd)).toBe(false);
    expect(gitReadOnly({ command: "x".repeat(1001) }, cwd)).toBe(false);
    expect(gitReadOnly({ command: "" }, cwd)).toBe(false);
    expect(gitReadOnly({}, cwd)).toBe(false);
    expect(gitReadOnly(null, cwd)).toBe(false);
    expect(gitReadOnly(["git status"], cwd)).toBe(false);
    expect(gitReadOnly({ command: "git status", description: "d", timeout: 5000 }, cwd)).toBe(true);
  });

  it("a cwd without its own .git is refused: git would find a parent repository", () => {
    expect(gitReadOnly({ command: "git status" }, bare)).toBe(false);
    expect(gitReadOnly({ command: "git status" }, join(root, "gone"))).toBe(false);
  });

  it("through tier(): low only with the shell cwd pinned", () => {
    expect(tier("Bash", { command: "git status" }, { cwd, bashCwdPinned: true })).toBe("low");
    expect(tier("Bash", { command: "git status" }, { cwd })).toBe("high");
    expect(tier("Bash", { command: "git status" }, { cwd, bashCwdPinned: true, blockedPath: "x" })).toBe("high");
  });
});
