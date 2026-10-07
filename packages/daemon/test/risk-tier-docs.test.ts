import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearGitExecCache } from "../src/git-readonly.ts";
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
    expect(t("Edit", rd("sub/new.ts"))).toBe("low");
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
    expect(w("src/a.ts")).toBe("low");
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

  it("an unreadable config fails closed: a Write into any hook-like folder is high, other Writes stay low", () => {
    // wt's .git file points nowhere: git config fails.
    for (const p of [".custom-hooks/x", "tools/githooks/x", ".husky/_/x"]) expect(w(wt, p), p).toBe("high");
    expect(w(wt, "sub/new.ts")).toBe("low");
  });

  it("a relative program script named in the repository config is high to Write", () => {
    const d = mk("w-prog");
    sh(d, "config", "diff.x.textconv", "./tools/conv.sh");
    sh(d, "config", "filter.y.clean", "scripts/clean.sh --flag");
    sh(d, "config", "core.fsmonitor", "./fsm.sh");
    sh(d, "config", "diff.external", "ext.sh");
    for (const p of ["tools/conv.sh", "scripts/clean.sh", "fsm.sh", "ext.sh"]) expect(w(d, p), p).toBe("high");
    expect(w(d, "tools/other.sh")).toBe("low");
  });

  it("a hooks folder named by core.hooksPath in a submodule's config is high to Write, and git status is high", { timeout: 120_000 }, () => {
    const upstream = mk("w-up");
    writeFileSync(join(upstream, "a"), "x");
    sh(upstream, "add", "a");
    sh(upstream, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "m");
    const host = mk("w-host");
    sh(host, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream.replaceAll("\\", "/"), "sub");
    expect(tier("Bash", { command: "git status" }, { cwd: host, bashCwdPinned: true })).toBe("low");
    sh(join(host, "sub"), "config", "core.hooksPath", ".githooks-x");
    clearGitExecCache();
    expect(w(host, "sub/.githooks-x/post-index-change")).toBe("high");
    expect(tier("Bash", { command: "git status" }, { cwd: host, bashCwdPinned: true })).toBe("high");
  });
});
