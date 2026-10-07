import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoSafety } from "../src/git-readonly.ts";
import { mainCheckoutOf, tier, type TierContext } from "../src/risk-tier.ts";

// Agent docs and the main checkout (GH-163). No symlinks: runs on Windows too.
const top = realpathSync(mkdtempSync(join(tmpdir(), "docs-")));
const main = join(top, "main");
const wt = join(main, ".claude", "worktrees", "w");
const other = join(main, ".claude", "worktrees", "other");
const plain = join(top, "plain");
const wrongGit = join(main, ".claude", "worktrees", "wrong");
const dirGit = join(main, ".claude", "worktrees", "dirgit");
const loose = join(top, "loose", ".claude", "worktrees", "l");

mkdirSync(join(main, ".git", "worktrees", "w"), { recursive: true });
for (const d of [".claude/skills/implement-issue/references", ".claude/skills/x", "docs", "sub/.claude/skills/x", "development-docs/GH-1", ".claude/worktrees/other/src", "sub"].map((d) => join(main, d))) mkdirSync(d, { recursive: true });
for (const d of [wt, plain, wrongGit, dirGit, loose]) mkdirSync(d, { recursive: true });
mkdirSync(join(wt, ".claude/skills/implement-issue/references"), { recursive: true });
mkdirSync(join(wt, "sub"), { recursive: true });
mkdirSync(join(dirGit, ".git"));
mkdirSync(join(plain, ".claude/skills/q"), { recursive: true });
mkdirSync(join(top, "parent-x"), { recursive: true });
// What `git worktree add` writes.
writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "w").replaceAll("\\", "/")}\n`);
writeFileSync(join(wrongGit, ".git"), `gitdir: ${join(top, "elsewhere").replaceAll("\\", "/")}\n`);
for (const f of [
  ".claude/skills/implement-issue/SKILL.md",
  ".claude/skills/implement-issue/references/x.md",
  ".claude/skills/x/.env",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/.credentials.json",
  ".claude/worktrees/other/src/a.ts",
  "sub/.claude/skills/x/SKILL.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".env",
  ".git/config",
  "docs/spec.md",
  "README.md",
  "development-docs/GH-1/plan.md",
  "sub/AGENTS.md",
]) writeFileSync(join(main, f), "x");
for (const f of [".claude/skills/implement-issue/SKILL.md", ".claude/skills/implement-issue/references/x.md", "CLAUDE.md", "sub/AGENTS.md"]) writeFileSync(join(wt, f), "x");
writeFileSync(join(plain, "CLAUDE.md"), "x");
writeFileSync(join(plain, ".claude/skills/q/SKILL.md"), "x");
writeFileSync(join(top, "parent-x", "x"), "x");
writeFileSync(join(top, "x"), "x");

const rd = (file_path: string) => ({ file_path });
const t = (tool: string, input: unknown, ctx: Partial<TierContext> = {}) => tier(tool, input, { cwd: wt, ...ctx });

describe("mainCheckoutOf", () => {
  it("a daemon-layout worktree gives its main checkout", () => {
    expect(mainCheckoutOf(wt)).toBe(main);
  });

  it("a cwd not under .claude/worktrees, a .git dir instead of a file, a missing .git or a gitdir outside <main>/.git/worktrees gives undefined", () => {
    expect(mainCheckoutOf(plain)).toBeUndefined();
    expect(mainCheckoutOf(main)).toBeUndefined();
    expect(mainCheckoutOf(dirGit)).toBeUndefined();
    expect(mainCheckoutOf(other)).toBeUndefined();
    expect(mainCheckoutOf(loose)).toBeUndefined();
    expect(() => mainCheckoutOf(wrongGit)).toThrow();
  });
});

describe("reads of agent docs and the main checkout", () => {
  const lowReads: [string, string, unknown][] = [
    ["Read main skill", "Read", rd(join(main, ".claude/skills/implement-issue/SKILL.md"))],
    ["Read worktree skill", "Read", rd(join(wt, ".claude/skills/implement-issue/SKILL.md"))],
    ["Read relative skill reference", "Read", rd(".claude/skills/implement-issue/references/x.md")],
    ["LS .claude/skills", "LS", { path: ".claude/skills" }],
    ["Glob in main skills", "Glob", { path: join(main, ".claude/skills/implement-issue"), pattern: "**/*.md" }],
    ["Grep in main docs", "Grep", { pattern: "x", path: join(main, "docs") }],
    ["Read main CLAUDE.md", "Read", rd(join(main, "CLAUDE.md"))],
    ["Read CLAUDE.md", "Read", rd("CLAUDE.md")],
    ["Read sub/AGENTS.md", "Read", rd("sub/AGENTS.md")],
    ["Read main docs/spec.md", "Read", rd(join(main, "docs/spec.md"))],
    ["Read main README.md", "Read", rd(join(main, "README.md"))],
    ["Read main scratch plan", "Read", rd(join(main, "development-docs/GH-1/plan.md"))],
    ["Read main sub/AGENTS.md", "Read", rd(join(main, "sub/AGENTS.md"))],
  ];
  const highReads: [string, string, unknown][] = [
    ["Read main settings.json", "Read", rd(join(main, ".claude/settings.json"))],
    ["Read main settings.local.json", "Read", rd(join(main, ".claude/settings.local.json"))],
    ["Read main .credentials.json", "Read", rd(join(main, ".claude/.credentials.json"))],
    ["Read another worktree", "Read", rd(join(main, ".claude/worktrees/other/src/a.ts"))],
    ["Read .env under skills", "Read", rd(join(main, ".claude/skills/x/.env"))],
    ["Read nested sub/.claude/skills", "Read", rd(join(main, "sub/.claude/skills/x/SKILL.md"))],
    ["Read main .env", "Read", rd(join(main, ".env"))],
    ["Read main .git/config", "Read", rd(join(main, ".git/config"))],
    ["Read main CLAUDE.local.md", "Read", rd(join(main, "CLAUDE.local.md"))],
    ["Read skills alias with a colon", "Read", rd(join(main, ".claude/skills:x"))],
    ["Read skills alias with a trailing dot", "Read", rd(join(main, ".claude/skills./x"))],
    ["Read .claude itself", "Read", rd(join(main, ".claude/skills/../settings.json"))],
    ["Grep the main root", "Grep", { pattern: "x", path: main }],
    ["Read above the main checkout", "Read", rd(join(top, "x"))],
    ["Read a sibling of the main checkout", "Read", rd(join(top, "parent-x", "x"))],
    ["Read with ..", "Read", rd(".claude/skills/../settings.json")],
    ["Glob .claude/** pattern", "Glob", { path: join(main, ".claude"), pattern: "**" }],
  ];

  it.each(lowReads)("low: %s", (_, tool, input) => expect(t(tool, input)).toBe("low"));
  it.each(highReads)("high: %s", (_, tool, input) => expect(t(tool, input)).toBe("high"));

  it("writes keep the old rules: .claude, CLAUDE.md, AGENTS.md and the main checkout are high", () => {
    for (const [tool, p] of [
      ["Edit", ".claude/skills/x/SKILL.md"],
      ["Write", ".claude/skills/new/SKILL.md"],
      ["Edit", "CLAUDE.md"],
      ["Edit", "sub/AGENTS.md"],
      ["Write", join(main, "CLAUDE.md")],
      ["Write", join(main, "docs/new.md")],
      ["Edit", join(main, ".claude/skills/x/SKILL.md")],
    ] as const)
      expect(t(tool, rd(p)), `${tool} ${p}`).toBe("high");
    // wt's .git file points nowhere: no Write is low there (fail closed); in a plain repository an ordinary Edit is.
    expect(t("Edit", rd("sub/new.ts"))).toBe("high");
    const plainRepo = join(top, "plain-edit");
    mkdirSync(plainRepo);
    execFileSync("git", ["init", "-q"], { cwd: plainRepo });
    expect(tier("Edit", rd("sub/new.ts"), { cwd: plainRepo })).toBe("low");
  });

  it("a plain folder (no worktree layout) reads its own agent docs but never a main checkout", () => {
    const c = { cwd: plain };
    expect(tier("Read", rd("CLAUDE.md"), c)).toBe("low");
    expect(tier("Read", rd(".claude/skills/q/SKILL.md"), c)).toBe("low");
    for (const p of [join(main, ".claude/skills/implement-issue/SKILL.md"), join(main, "CLAUDE.md"), join(main, "docs/spec.md"), join(main, ".claude/settings.json")]) expect(tier("Read", rd(p), c), p).toBe("high");
    expect(tier("Read", rd(".claude/settings.json"), c)).toBe("high");
  });

  it("a forged layout does not widen reads: a gitdir outside <main>/.git/worktrees is high, not a main checkout", () => {
    expect(tier("Read", rd(join(main, "docs/spec.md")), { cwd: wrongGit })).toBe("high");
    expect(tier("Read", rd(join(main, "docs/spec.md")), { cwd: dirGit })).toBe("high");
  });
});

describe("Bash with the shell cwd pinned", () => {
  it("read-only git is low in a repository, only while pinned", () => {
    const repo = join(top, "plainrepo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const b = (command: string, ctx: Partial<TierContext> = {}) => tier("Bash", { command }, { cwd: repo, ...ctx });
    expect(b("git status", { bashCwdPinned: true })).toBe("low");
    expect(b("git status")).toBe("high");
    expect(b("git status", { bashCwdPinned: true, blockedPath: "x" })).toBe("high");
    expect(b("git status > x.txt", { bashCwdPinned: true })).toBe("high");
    // A worktree whose .git file points nowhere has no readable config: high.
    expect(t("Bash", { command: "git status" }, { bashCwdPinned: true })).toBe("high");
  });
});

describe("secrets of the main checkout and hook folders (GH-163 review)", () => {
  const cfgDir = join(main, "development-docs", "GH-1", "ui-cfg", "claude-ui");
  mkdirSync(cfgDir, { recursive: true });
  for (const f of ["token", "vapid.json", "push-subscriptions.json", "settings.json", "sessions.json"]) writeFileSync(join(cfgDir, f), "secret");
  mkdirSync(join(main, ".config", "claude-ui"), { recursive: true });
  writeFileSync(join(main, ".config", "claude-ui", "token"), "secret");
  writeFileSync(join(main, "development-docs", "GH-1", "vapid.json"), "secret");

  it("a daemon config folder, vapid.json and push-subscriptions.json are high to read, also by Grep and Glob", () => {
    for (const f of ["token", "vapid.json", "push-subscriptions.json"]) expect(t("Read", rd(join(cfgDir, f))), f).toBe("high");
    expect(t("Read", rd(join(main, ".config/claude-ui/token")))).toBe("high");
    expect(t("Read", rd(join(main, "development-docs/GH-1/vapid.json")))).toBe("high");
    expect(t("Grep", { pattern: "x", path: join(main, "development-docs", "GH-1", "ui-cfg") })).toBe("high");
    expect(t("LS", { path: cfgDir })).toBe("high");
    expect(t("Read", rd(join(main, "development-docs/GH-1/plan.md")))).toBe("low");
  });

  it("a Write into the folder core.hooksPath names inside the worktree is high; elsewhere stays low", () => {
    const repo = join(top, "hooked");
    mkdirSync(join(repo, ".husky", "_"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: repo });
    const w = (p: string) => tier("Write", { file_path: p }, { cwd: repo });
    expect(w(".husky/_/post-index-change")).toBe("high");
    expect(w(".husky/_/sub/x")).toBe("high");
    expect(w(join(repo, ".husky/_/post-index-change"))).toBe("high");
    // A hooks folder in the worktree: not a plain repository, every Write is high.
    expect(w("src/a.ts")).toBe("high");
    // A folder named .husky or hooks is high by name, config or not.
    expect(tier("Write", { file_path: ".husky/_/x" }, { cwd: plain })).toBe("high");
  });
});

describe("hook folders and config scripts are never low Writes (GH-163 round 2)", () => {
  const sh = (d: string, ...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const mk = (name: string) => {
    const d = join(top, name);
    mkdirSync(d, { recursive: true });
    sh(d, "init", "-q");
    return d;
  };
  const w = (cwd: string, p: string, tool = "Write") => tier(tool, { file_path: p, content: "x" }, { cwd });

  it("a path component named hooks or .husky is high anywhere in the worktree, config or not, case-insensitive", () => {
    const d = mk("w-comp");
    for (const p of [".husky/_/post-index-change", "sub/.husky/_/post-index-change", "hooks/pre-commit", "a/b/Hooks/x", "sub/.HUSKY/x", ".husky/pre-commit"]) expect(w(d, p), p).toBe("high");
    expect(w(d, "src/hook-utils.ts")).toBe("low");
    expect(w(d, "src/a.ts")).toBe("low");
  });

  it("an unreadable config fails closed: every Write is high (round 3 M1)", () => {
    // wt's .git file points nowhere: git config fails.
    for (const p of [".custom-hooks/x", "tools/githooks/x", ".husky/_/x", "sub/new.ts", "src/a.ts"]) expect(w(wt, p), p).toBe("high");
    expect(repoSafety(wt)).toMatchObject({ unsafe: true, failed: true });
  });

  it("a relative program script named in the repository config is high to Write", () => {
    const d = mk("w-prog");
    sh(d, "config", "diff.x.textconv", "./tools/conv.sh");
    sh(d, "config", "filter.y.clean", "scripts/clean.sh --flag");
    sh(d, "config", "core.fsmonitor", "./fsm.sh");
    sh(d, "config", "diff.external", "ext.sh");
    for (const p of ["tools/conv.sh", "scripts/clean.sh", "fsm.sh", "ext.sh"]) expect(w(d, p), p).toBe("high");
    // Not a plain repository: every Write is high.
    expect(w(d, "tools/other.sh")).toBe("high");
  });

  it("a hooks folder named by core.hooksPath in a submodule's config is high to Write, and git status is high", { timeout: 120_000 }, () => {
    const upstream = mk("w-up");
    writeFileSync(join(upstream, "a"), "x");
    sh(upstream, "add", "a");
    sh(upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "m");
    const host = mk("w-host");
    sh(host, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream.replaceAll("\\", "/"), "sub");
    // A submodule alone makes the repository not plain.
    expect(tier("Bash", { command: "git status" }, { cwd: host, bashCwdPinned: true })).toBe("high");
    sh(join(host, "sub"), "config", "core.hooksPath", ".githooks-x");
    expect(w(host, "sub/.githooks-x/post-index-change")).toBe("high");
    expect(tier("Bash", { command: "git status" }, { cwd: host, bashCwdPinned: true })).toBe("high");
  });
});

describe("a worker changes what git reads, then the tier is asked again (GH-163 round 3)", () => {
  const sh = (d: string, ...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const mk = (name: string) => {
    const d = join(top, name);
    mkdirSync(d, { recursive: true });
    sh(d, "init", "-q");
    return d;
  };
  const commit = (d: string) => sh(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "m");
  const w = (cwd: string, p: string) => tier("Write", { file_path: p, content: "x" }, { cwd });
  const status = (cwd: string) => tier("Bash", { command: "git status" }, { cwd, bashCwdPinned: true });
  /** What the worker does once a Write was low: the test writes the file itself. */
  const plant = (cwd: string, p: string, text: string) => {
    mkdirSync(join(cwd, p, ".."), { recursive: true });
    writeFileSync(join(cwd, p), text);
  };

  it("B1: emptying .gitmodules does not hide a submodule whose config names a hooks folder", { timeout: 120_000 }, () => {
    const upstream = mk("r3-up");
    writeFileSync(join(upstream, "a"), "x");
    sh(upstream, "add", "a");
    commit(upstream);
    const host = mk("r3-host");
    sh(host, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream.replaceAll("\\", "/"), "sub");
    sh(join(host, "sub"), "config", "core.hooksPath", ".githooks-x");
    expect(w(host, ".gitmodules")).toBe("high");
    // Had the Write been allowed (or approved by the user): the index still holds the gitlink.
    plant(host, ".gitmodules", "");
    expect(w(host, "sub/.githooks-x/post-index-change")).toBe("high");
    expect(w(host, "sub/plain.txt")).toBe("high");
    expect(status(host)).toBe("high");
    // Malformed .gitmodules (round 3 M1's way to force a failed scan): still high.
    plant(host, ".gitmodules", '[submodule "sub"');
    expect(w(host, "sub/.githooks-x/post-index-change")).toBe("high");
    expect(status(host)).toBe("high");
    // Gone from disk too: the gitlink in the index still decides.
    rmSync(join(host, ".gitmodules"));
    expect(repoSafety(host).unsafe).toBe(true);
    expect(status(host)).toBe("high");
  });

  it("a gitlink in the index alone (no .gitmodules, no checked-out folder) makes the repository not plain", () => {
    const d = mk("r3-gitlink");
    commit(d);
    expect(status(d)).toBe("low");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
    sh(d, "update-index", "--add", "--cacheinfo", `160000,${head},lib`);
    expect(repoSafety(d).why.join()).toMatch(/gitlink/);
    expect(status(d)).toBe("high");
    expect(w(d, "src/a.ts")).toBe("high");
  });

  it("B2: an include.path target inside the cwd is high to Write and makes the repository not plain", () => {
    const d = mk("r3-inc");
    sh(d, "config", "include.path", "../.gitconfig");
    expect(w(d, ".gitconfig")).toBe("high");
    expect(status(d)).toBe("high");
    const e = mk("r3-inc-abs");
    const target = join(e, "shared", "repo.cfg");
    plant(e, "shared/repo.cfg", "");
    sh(e, "config", "include.path", target.replaceAll("\\", "/"));
    expect(w(e, "shared/repo.cfg")).toBe("high");
    expect(repoSafety(e).protectedPaths).toContain(realpathSync(target));
    // The worker plants core.fsmonitor in the include target (as if the Write had gone through): still high, and so is every Write.
    plant(e, "shared/repo.cfg", "[core]\n\tfsmonitor = ./fsm.sh\n");
    expect(status(e)).toBe("high");
    expect(w(e, "src/a.ts")).toBe("high");
  });

  it("an include outside the cwd is the user's own: the repository stays plain", () => {
    const d = mk("r3-inc-out");
    const outside = join(top, "r3-shared.cfg");
    writeFileSync(outside, "[core]\n\tautocrlf = false\n");
    sh(d, "config", "include.path", outside.replaceAll("\\", "/"));
    expect(status(d)).toBe("low");
    expect(w(d, "src/a.ts")).toBe("low");
  });

  it("m1: a ~ path is expanded before the inside check", () => {
    const home = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = top;
    try {
      const d = mk("r3-home");
      sh(d, "config", "core.hooksPath", "~/r3-home/.gh");
      expect(w(d, ".gh/post-index-change")).toBe("high");
      expect(status(d)).toBe("high");
      const o = mk("r3-home-out");
      sh(o, "config", "core.hooksPath", "~/elsewhere-hooks");
      expect(status(o)).toBe("low");
    } finally {
      for (const [k, v] of Object.entries(home)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });

  it("a nested repository with a planted hook makes the repository not plain", () => {
    const d = mk("r3-nested");
    expect(status(d)).toBe("low");
    expect(w(d, "inner/.git/hooks/post-index-change")).toBe("high");
    // A nested repository the user (or an approved command) created.
    mkdirSync(join(d, "inner"));
    sh(join(d, "inner"), "init", "-q");
    sh(join(d, "inner"), "config", "core.hooksPath", ".h");
    plant(d, "inner/.h/post-index-change", "#!/bin/sh\necho pwned\n");
    expect(status(d)).toBe("high");
    expect(w(d, "src/a.ts")).toBe("high");
  });

  it("git's control files are high to Write in a plain repository; ordinary files and .github stay low", () => {
    const d = mk("r3-names");
    for (const p of [".gitmodules", ".gitattributes", ".gitconfig", ".gitignore", "sub/.gitattributes", ".githooks/pre-commit", ".githooks-x/x", ".husky-hooks/x", ".lfsconfig", "a/.GITMODULES"]) expect(w(d, p), p).toBe("high");
    for (const p of ["src/a.ts", ".github/workflows/ci.yml", ".gitlab-ci.yml", "docs/git.md"]) expect(w(d, p), p).toBe("low");
    expect(status(d)).toBe("low");
  });

  it("a .gitmodules file anywhere makes the repository not plain", () => {
    const d = mk("r3-gm");
    commit(d);
    plant(d, "deep/.gitmodules", "");
    expect(status(d)).toBe("high");
    expect(w(d, "src/a.ts")).toBe("high");
  });

  it("a config value that names a file in the cwd protects it (core.attributesFile)", () => {
    const d = mk("r3-attr");
    sh(d, "config", "core.attributesFile", "./my.attributes");
    expect(w(d, "my.attributes")).toBe("high");
    expect(w(d, "src/a.ts")).toBe("low");
  });
});
