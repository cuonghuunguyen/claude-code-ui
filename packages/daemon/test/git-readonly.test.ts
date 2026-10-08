import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitReadOnly, gitThreadConfig, repoSafety, repoSafetyAsync } from "../src/git-readonly.ts";
import { tier, tierAsync } from "../src/risk-tier.ts";

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

    it("no cache: a config change is seen by the very next ask", () => {
      const d = withConfig("nocache");
      expect(repoSafety(d).unsafe).toBe(false);
      git(d, "config", "core.hooksPath", ".hk");
      expect(repoSafety(d).unsafe).toBe(true);
      expect(gitReadOnly({ command: "git status" }, d)).toBe(false);
    });

    it("the async read gives the same facts, shares a scan in flight, keeps nothing after it and leaves the event loop free", async () => {
      const d = withConfig("async");
      expect(await repoSafetyAsync(d)).toEqual(repoSafety(d));
      const a = repoSafetyAsync(d);
      expect(repoSafetyAsync(d)).toBe(a);
      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      await a;
      clearInterval(timer);
      // Timers ran while git did: the scan did not hold the loop.
      expect(ticks).toBeGreaterThan(0);
      expect(repoSafetyAsync(d)).not.toBe(a);
      // A scan in flight that started before a change the caller knows of is not shared.
      const before = repoSafetyAsync(d);
      git(d, "config", "core.hooksPath", ".hk");
      const after = repoSafetyAsync(d, performance.now());
      expect(after).not.toBe(before);
      expect((await after).unsafe).toBe(true);
      await before;
      expect(await tierAsync("Bash", { command: "git status" }, { cwd: d, bashCwdPinned: true })).toBe("high");
      expect(await tierAsync("Write", { file_path: "src/x.ts" }, { cwd: d })).toBe("high");
      expect(await repoSafetyAsync(join(root, "gone"))).toMatchObject({ unsafe: true, failed: true });
      expect(await tierAsync("Write", { file_path: "x.ts" }, { cwd: join(root, "gone") })).toBe("high");
    });

    it("tierAsync matches tier for every low and high row", async () => {
      for (const command of [...low, ...high.filter((h) => typeof h === "string")] as string[]) {
        expect(await tierAsync("Bash", { command }, { cwd, bashCwdPinned: true }), command).toBe(tier("Bash", { command }, { cwd, bashCwdPinned: true }));
      }
    }, 300_000);

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

describe("the git thread fails closed and recovers (GH-163 round 5 review m1-m3)", () => {
  const defaults = { script: gitThreadConfig.script, queueTimeoutMs: gitThreadConfig.queueTimeoutMs, walkDeadlineMs: gitThreadConfig.walkDeadlineMs };
  afterEach(() => {
    Object.assign(gitThreadConfig, defaults);
    gitThreadConfig.reset();
    vi.restoreAllMocks();
  });
  const d = repo(join(root, "thread"));

  it("a thread that errors is marked broken, logged, and child processes take over", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gitThreadConfig.reset();
    gitThreadConfig.script = "throw new Error('boom')";
    expect(await repoSafetyAsync(d)).toMatchObject({ unsafe: true, failed: true });
    expect(gitThreadConfig.broken).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/git thread failed/);
    expect(await repoSafetyAsync(d)).toMatchObject({ unsafe: false, failed: false });
  });

  it("a thread that exits fails its reads; the next read starts a new thread", async () => {
    gitThreadConfig.reset();
    gitThreadConfig.script = "require('node:worker_threads').parentPort.on('message', () => process.exit(3));";
    expect(await repoSafetyAsync(d)).toMatchObject({ unsafe: true, failed: true });
    expect(gitThreadConfig.broken).toBe(false);
    gitThreadConfig.script = defaults.script;
    expect(await repoSafetyAsync(d)).toMatchObject({ unsafe: false, failed: false });
  });

  it("a thread that does not answer in time fails the read and is replaced", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    gitThreadConfig.reset();
    gitThreadConfig.script = "require('node:worker_threads').parentPort.on('message', () => {});";
    gitThreadConfig.queueTimeoutMs = 200;
    expect(await repoSafetyAsync(d)).toMatchObject({ unsafe: true, failed: true });
    gitThreadConfig.script = defaults.script;
    gitThreadConfig.queueTimeoutMs = defaults.queueTimeoutMs;
    expect(await repoSafetyAsync(d)).toMatchObject({ unsafe: false, failed: false });
  });

  it("a walk past its time limit is unsafe", async () => {
    gitThreadConfig.walkDeadlineMs = -1;
    writeFileSync(join(d, "f.txt"), "x");
    const r = await repoSafetyAsync(d);
    expect(r.unsafe).toBe(true);
    expect(r.why.join()).toMatch(/took too long/);
    expect(repoSafety(d).unsafe).toBe(true);
  });
});
