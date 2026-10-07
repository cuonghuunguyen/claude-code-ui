import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearGitExecCache, gitExecConfig, gitReadOnly } from "../src/git-readonly.ts";
import { tier } from "../src/risk-tier.ts";

// No symlinks here: this file runs on Windows too (risk-tier.test.ts holds the symlink rows).
const root = realpathSync(mkdtempSync(join(tmpdir(), "gro-")));
const cwd = join(root, "repo");
const bare = join(root, "norepo");
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
/** A real repository: the exec-config check asks git for its effective config. */
const repo = (dir: string) => (mkdirSync(dir, { recursive: true }), git(dir, "init", "-q"), dir);
for (const d of ["src", ".claude/skills/x"]) mkdirSync(join(cwd, d), { recursive: true });
repo(cwd);
mkdirSync(bare);
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
  "git log --branches --tags --oneline",
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
  // Refs-wide and stash reads print untracked files a stash -u keeps in the shared refs (GH-163 review).
  "git show stash@{0}^3",
  "git show stash@{0}",
  "git diff stash@{1}",
  "git log refs/stash",
  "git log STASH",
  "git log --all",
  "git log --all -p",
  "git log --all --oneline",
  "git show refs/heads/main",
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

  describe("repository config that names a program or hook folder inside the worktree (GH-163 review)", () => {
    const withConfig = (name: string, ...kv: string[]) => {
      const d = repo(join(root, name));
      for (let i = 0; i < kv.length; i += 2) git(d, "config", kv[i]!, kv[i + 1]!);
      return d;
    };
    const runsCode = ["git status", "git diff", "git log", "git log -p", "git show HEAD", "git --no-optional-locks status", "git status; git log"];
    const safe = ["git rev-parse HEAD", "git branch --show-current", "git rev-parse --show-toplevel; git branch --show-current"];
    const unsafeConfigs: [string, string[]][] = [
      ["relative core.hooksPath (husky v9)", ["core.hooksPath", ".husky/_"]],
      ["relative core.hooksPath ./hooks", ["core.hooksPath", "./hooks"]],
      ["core.hooksPath = .", ["core.hooksPath", "."]],
      ["core.hooksPath absolute inside", ["core.hooksPath", "%CWD%/hk"]],
      ["core.fsmonitor program", ["core.fsmonitor", "./fsm.sh"]],
      ["core.fsmonitor absolute with args", ["core.fsmonitor", "/usr/bin/x ./fsm.sh"]],
      ["diff.external relative", ["diff.external", "./diff.sh"]],
      ["textconv", ["diff.x.textconv", "./conv.sh"]],
      ["diff driver command", ["diff.x.command", "./d.sh"]],
      ["filter clean", ["filter.x.clean", "./c.sh"]],
      ["filter smudge", ["filter.x.smudge", "./s.sh"]],
      ["filter process", ["filter.x.process", "./p.sh"]],
    ];
    it.each(unsafeConfigs)("%s: status, diff, log and show are refused; rev-parse and branch --show-current stay", (name, kv) => {
      const d = withConfig(`cfg-${name.replace(/\W+/g, "-")}`, ...kv.map((v) => v.replace("%CWD%", "")));
      if (kv[1]!.startsWith("%CWD%")) git(d, "config", "core.hooksPath", `${d.replaceAll("\\", "/")}/hk`);
      for (const c of runsCode) expect(gitReadOnly({ command: c }, d), c).toBe(false);
      for (const c of safe) expect(gitReadOnly({ command: c }, d), c).toBe(true);
    });

    it("harmless config stays low: hooksPath outside the worktree, boolean fsmonitor, no program", () => {
      const outside = join(root, "elsewhere-hooks").replaceAll("\\", "/");
      for (const kv of [["core.hooksPath", outside], ["core.fsmonitor", "false"], ["core.fsmonitor", "true"], ["diff.external", ""], ["core.autocrlf", "true"]] as const) {
        const d = withConfig(`ok-${kv[0]}-${kv[1].length}`, kv[0], kv[1]);
        expect(gitReadOnly({ command: "git status" }, d), kv.join("=")).toBe(true);
        expect(gitReadOnly({ command: "git log -p" }, d), kv.join("=")).toBe(true);
      }
    }, 120_000);

    it("a program outside the worktree as one absolute path is the user's own and stays low", () => {
      const d = withConfig("ok-prog", "diff.external", join(root, "bin", "mydiff").replaceAll("\\", "/"));
      expect(gitReadOnly({ command: "git diff" }, d)).toBe(true);
    });

    it("the config is read once per cwd for 5 s (a tier decision asks several times)", () => {
      const d = withConfig("cached");
      clearGitExecCache();
      const first = gitExecConfig(d);
      git(d, "config", "core.hooksPath", ".hk");
      expect(gitExecConfig(d)).toBe(first);
      expect(first.unsafe).toBe(false);
      clearGitExecCache();
      expect(gitExecConfig(d).unsafe).toBe(true);
    });

    it("an include.path into the worktree, a relative gpg.program and a relative hooksPath written as an absolute path inside are refused", () => {
      for (const [k, v] of [["include.path", "../extra.cfg"], ["gpg.program", "./gpg.sh"]] as const) {
        const d = withConfig(`inc-${k}`, k, v);
        expect(gitReadOnly({ command: "git log" }, d), k).toBe(false);
        expect(gitReadOnly({ command: "git branch --show-current" }, d), k).toBe(true);
      }
      const d = withConfig("abs-hooks");
      git(d, "config", "core.hooksPath", join(d, "hk").replaceAll("\\", "/"));
      expect(gitReadOnly({ command: "git status" }, d)).toBe(false);
      if (process.platform === "win32") {
        const drive = d.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, l: string) => `/${l.toLowerCase()}`);
        git(d, "config", "core.hooksPath", `${drive}/hk`);
        clearGitExecCache();
        expect(gitReadOnly({ command: "git status" }, d), "/c/... form").toBe(false);
      }
    });

    it("a directory that git cannot read config in is refused", () => {
      expect(gitReadOnly({ command: "git status" }, join(root, "gone"))).toBe(false);
    });
  });

  it("through tier(): low only with the shell cwd pinned", () => {
    expect(tier("Bash", { command: "git status" }, { cwd, bashCwdPinned: true })).toBe("low");
    expect(tier("Bash", { command: "git status" }, { cwd })).toBe("high");
    expect(tier("Bash", { command: "git status" }, { cwd, bashCwdPinned: true, blockedPath: "x" })).toBe("high");
  });
});
