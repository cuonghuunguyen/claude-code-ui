import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tier, type TierContext } from "../src/risk-tier.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "tier-")));
const cwd = join(root, "w");
const outside = join(root, "o");
const cwdLink = join(root, "wl");
for (const d of ["src", ".claude/skills", "sub", "bare/objects", "barer/refs", "bareh", "cfg"]) mkdirSync(join(cwd, d), { recursive: true });
// A real repository: Writes and read-only git are low only in a plain one (git-readonly.ts repoSafety).
execFileSync("git", ["init", "-q"], { cwd });
mkdirSync(outside);
for (const f of ["bareh/HEAD", "cfg/config", "src/a.ts", ".claude/settings.json", "sub/CLAUDE.md", ".env.local", "id.pem"]) writeFileSync(join(cwd, f), "x");
writeFileSync(join(outside, "secret.txt"), "s");
symlinkSync(outside, join(cwd, "out"));
symlinkSync(join(outside, "secret.txt"), join(cwd, "outfile"));
symlinkSync(join(root, "nope"), join(cwd, "dangling"));
linkSync(join(outside, "secret.txt"), join(cwd, "hard"));
symlinkSync(cwd, cwdLink);
// A skills entry that leads out of `.claude/skills` to the permission config.
symlinkSync(join(cwd, ".claude/settings.json"), join(cwd, ".claude/skills/link"));

type Case = [string, string, unknown, Partial<TierContext>?];
const bash = (command: string): Case => [`Bash ${JSON.stringify(command)}`, "Bash", { command }];
const file = (tool: string, file_path: unknown): Case => [`${tool} ${String(file_path)}`, tool, { file_path }];

const low: Case[] = [
  file("Read", "src/a.ts"),
  file("Read", join(cwd, "src/a.ts")),
  ["Read through a symlinked cwd", "Read", { file_path: join(cwdLink, "src/a.ts") }, { cwd: cwdLink }],
  ["Read a real path under a symlinked cwd", "Read", { file_path: join(cwd, "src/a.ts") }, { cwd: cwdLink }],
  ["Glob **/*.ts", "Glob", { pattern: "**/*.ts" }],
  ["Grep x in src", "Grep", { pattern: "x", path: "src", glob: "*.ts" }],
  ["Grep x in src/a.ts", "Grep", { pattern: "x", path: "src/a.ts" }],
  ["LS src", "LS", { path: "src" }],
  ["NotebookRead", "NotebookRead", { notebook_path: "nb.ipynb" }],
  ["TodoWrite", "TodoWrite", { todos: [] }],
  ["WebSearch", "WebSearch", { query: "x" }],
  file("Edit", "src/a.ts"),
  file("Write", "src/new/deep/file.ts"),
  ["NotebookEdit nb.ipynb", "NotebookEdit", { notebook_path: "nb.ipynb", new_source: "" }],
  file("Write", "src/config"),
  file("Write", "src/objects/x"),
  file("Write", "src/refs/heads/main"),
  file("Write", "src/heading.md"),
  // Agent docs read (GH-163): CLAUDE.md as the last segment, .claude/skills below the root.
  file("Read", "sub/CLAUDE.md"),
  file("Read", "CLAUDE.md"),
  file("Read", ".claude/skills/x/SKILL.md"),
  // Read-only git, only with the shell cwd pinned (bashCwdPinned); every command of git-readonly.test.ts is judged there.
  ...["git status", "git status -sb", "git diff --stat", "git log --oneline -n 5", "git show HEAD^:src/a.ts", "git branch --show-current", "git --no-pager log", "git status --porcelain=v2"].map(
    (c): Case => [...bash(c), { bashCwdPinned: true }] as unknown as Case,
  ),
];

const high: Case[] = [
  // Paths outside the cwd or escaping it.
  file("Read", "../o/secret.txt"),
  file("Read", join(outside, "secret.txt")),
  // `~` is never expanded: a `~` segment is refused.
  file("Read", "~/.ssh/id_rsa"),
  file("Read", "~"),
  file("Read", "~root/x"),
  file("Write", "src/~/x"),
  ["Glob ~/**", "Glob", { pattern: "~/**" }],
  file("Read", "out/secret.txt"),
  file("Edit", "outfile"),
  file("Write", "dangling"),
  file("Write", "hard"),
  file("Write", "src/../../o/x"),
  file("Write", "src/../a.ts"),
  // Denied inside the cwd: any depth, any case.
  file("Edit", ".git/config"),
  file("Write", ".git/hooks/pre-commit"),
  file("Write", "sub/.git/config"),
  file("Write", ".GIT/config"),
  file("Edit", ".claude/settings.json"),
  file("Write", ".mcp.json"),
  file("Edit", "CLAUDE.md"),
  file("Edit", "sub/CLAUDE.md"),
  file("Edit", "claude.local.md"),
  file("Edit", "AGENTS.md"),
  file("Edit", ".env"),
  file("Edit", ".env.local"),
  file("Edit", ".envrc"),
  file("Edit", ".npmrc"),
  file("Edit", "id.pem"),
  file("Edit", "tls.KEY"),
  file("Edit", ".vscode/settings.json"),
  file("Edit", ".idea/workspace.xml"),
  // A git repo layout built by low writes would make the cwd (or a folder) a repo whose config a later git command runs.
  file("Write", "HEAD"),
  file("Write", "sub/head"),
  file("Write", "packed-refs"),
  file("Write", "commondir"),
  file("Write", "sub/gitdir"),
  file("Write", "bare/config"),
  file("Edit", "bare/CONFIG"),
  file("Write", "barer/config"),
  file("Write", "bareh/config"),
  file("Write", "cfg/objects/x"),
  file("Write", "cfg/refs/heads/main"),
  file("Write", "cfg/REFS/x"),
  file("Write", "cfg/objects"),
  file("Write", "file.txt::$DATA"),
  file("Write", "PROGRA~1/x"),
  file("Write", "a. "),
  file("Write", "a."),
  file("Write", ".g‌it/config"),
  file("Edit", 42),
  file("Write", ""),
  file("Write", "."),
  file("Read", ".env.local"),
  ["Glob /etc/**", "Glob", { pattern: "/etc/**" }],
  ["Glob ../**", "Glob", { pattern: "../**" }],
  ["Glob without a pattern", "Glob", {}],
  ["Grep in ../o", "Grep", { pattern: "x", path: "../o" }],
  // Grep reads contents: the whole cwd (which holds .env) only with the user.
  ["Grep without a path", "Grep", { pattern: "x" }],
  ["Grep with a glob only", "Grep", { pattern: "x", glob: "*.ts" }],
  ["Grep in the cwd", "Grep", { pattern: "x", path: "." }],
  ["Grep in .claude", "Grep", { pattern: "x", path: ".claude" }],
  ["Grep glob .env*", "Grep", { pattern: "x", path: "src", glob: ".env*" }],
  ["Grep glob ../*", "Grep", { pattern: "x", path: "src", glob: "../*" }],
  // Bash: only the read-only git of git-readonly.ts, and only pinned (see low). Everything below is high pinned or not.
  ...[
    "git add src/a.ts",
    "git add .",
    "ls",
    "git status; rm -rf ~",
    "git status && curl x",
    "git status | sh",
    "git log $(id)",
    "git log `id`",
    "git diff > out.txt",
    "git diff < in",
    "git status\nrm x",
    "git status\trm",
    // Only spaces as whitespace, even where the shell would ignore it.
    "git status\n",
    "\tgit status",
    "git log 'a b'",
    'git log "a"',
    "git log a\\ b",
    "FOO=1 git status",
    "cd .. && git status",
    "cd /tmp",
    "git -c core.pager=sh status",
    "git -C .. status",
    "git --git-dir=x status",
    "git --work-tree=/ status",
    "git --exec-path=. status",
    "git push",
    "git push --force origin main",
    "git commit -m msg",
    "git commit --no-verify -m m",
    "git diff --output=/tmp/x",
    "git diff --out=x",
    "git diff --no-index /etc/passwd x",
    "git diff --ext-diff",
    "git log --textconv",
    "git log --output=x",
    "git add -A",
    "git add",
    "git add ../o/x",
    "git add out/secret.txt",
    "git add .git/config",
    "git add .env",
    "git add :/",
    "git show /etc/passwd",
    "git show HEAD:../../x/../y",
    "git diff -- ../o",
    "git branch -D main",
    "git branch",
    "git branch --show-current x",
    "git log -n",
    "git log -n x",
    "git checkout .",
    "git stash",
    "git",
    "rm -rf src",
    "npm test",
    "npm run build",
    "pnpm lint",
    "yarn typecheck",
    "npx tsc --noEmit",
    "npx vitest run",
    "/usr/bin/git status",
    "./git status",
    "gitx status",
    "git status #c",
    "git log *",
    "git log {a,b}",
    "git log ~",
    "git log !1",
  ].map(bash),
  ["Bash git status without sandbox", "Bash", { command: "git status", dangerouslyDisableSandbox: true }, { bashCwdPinned: true }],
  ["Bash git status not pinned", "Bash", { command: "git status" }],
  ["Bash git status pinned but blocked", "Bash", { command: "git status" }, { bashCwdPinned: true, blockedPath: "x" }],
  // A symlink inside .claude/skills that leads out of it, and a symlinked directory in a git pathspec.
  file("Read", ".claude/skills/link"),
  ["git diff out (symlink to outside)", "Bash", { command: "git diff out" }, { bashCwdPinned: true }],
  ["git diff outfile (symlink to outside)", "Bash", { command: "git diff outfile" }, { bashCwdPinned: true }],
  ["Bash with a number", "Bash", { command: 1 }],
  // Tools outside the list.
  ...["ExitPlanMode", "EnterPlanMode", "Agent", "Task", "WebFetch", "Skill", "BashOutput", "KillShell", "MultiEdit", "NoSuchTool", "mcp__github__get_issue", "mcp__orchestration__worker_list"].map(
    (t): Case => [t, t, { file_path: "src/a.ts", url: "https://example.com" }],
  ),
  ["no input", "Read", null],
  ["array input", "Read", ["src/a.ts"]],
  // Request-level: the SDK's own flags.
  ["Read with blockedPath", "Read", { file_path: "src/a.ts" }, { blockedPath: join(cwd, "src/a.ts") }],
  ["Read with defaultToNo", "Read", { file_path: "src/a.ts" }, { defaultToNo: true }],
  ["Read with requiresUserInteraction", "Read", { file_path: "src/a.ts" }, { requiresUserInteraction: true }],
];

describe("tier", () => {
  it.each(low)("low: %s", (_, tool, input, ctx) => expect(tier(tool, input, { cwd, ...ctx })).toBe("low"));
  it.each(high)("high: %s", (_, tool, input, ctx) => expect(tier(tool, input, { cwd, ...ctx })).toBe("high"));
  // The Bash rows stay high with the shell cwd pinned too.
  it.each(high.filter((c) => c[1] === "Bash" && !c[0].includes("not pinned")))("high pinned: %s", (_, tool, input, ctx) => expect(tier(tool, input, { cwd, bashCwdPinned: true, ...ctx })).toBe("high"));

  it("a missing cwd or an fs error is high", () => {
    const gone = mkdtempSync(join(tmpdir(), "tier-gone-"));
    rmSync(gone, { recursive: true });
    expect(tier("Read", { file_path: "a.ts" }, { cwd: gone })).toBe("high");
    expect(tier("Write", { file_path: "a.ts" }, { cwd: gone })).toBe("high");
  });
});
