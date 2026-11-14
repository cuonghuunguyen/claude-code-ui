// GH-755: a worker's scratch folder is a `worktree.symlinkDirectories` link to the main checkout. A Write there is low.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tier } from "../src/risk-tier.ts";
import { sharedDirs } from "../src/shared-dirs.ts";
import { repoSafety } from "../src/git-readonly.ts";
import { canSymlink, NO_SYMLINK } from "./symlink-support.ts";
import { fixtureGit, sharedFixture } from "./shared-dirs-fixture.ts";

const write = (cwd: string, file_path: string) => tier("Write", { file_path }, { cwd });

describe.skipIf(!canSymlink)(`shared folder of a worker (${canSymlink ? "symlinks" : NO_SYMLINK})`, () => {
  it("sharedDirs: the link's real target, only for a listed, matching link", () => {
    const f = sharedFixture();
    expect(sharedDirs(f.wt)).toEqual([f.shared]);
    expect(sharedDirs(f.main)).toEqual([]);
  });

  it("a Write below the shared folder is low: relative and absolute through the link, and the absolute main path", () => {
    const { main, wt } = sharedFixture();
    expect(write(wt, "development-docs/K/ledger.md")).toBe("low");
    expect(write(wt, join(wt, "development-docs/K/ledger.md"))).toBe("low");
    expect(write(wt, join(main, "development-docs/K/notes.md"))).toBe("low");
    expect(tier("Edit", { file_path: join(main, "development-docs/K/notes.md") }, { cwd: wt })).toBe("low");
    expect(write(wt, "packages/x.ts")).toBe("low");
  });

  it("the shared folder itself, the main checkout's other files and a Bash heredoc stay high", () => {
    const { main, wt } = sharedFixture();
    expect(write(wt, join(main, "development-docs"))).toBe("high");
    expect(write(wt, join(main, "packages/x.ts"))).toBe("high");
    expect(write(wt, join(main, "README.md"))).toBe("high");
    expect(tier("Bash", { command: "cat > development-docs/K/a.md <<'EOF'\nx\nEOF" }, { cwd: wt, bashCwdPinned: true })).toBe("high");
  });

  it.each([
    ["the link is not listed in the settings", { list: [] }],
    ["another entry is listed", { list: ["notes"] }],
    ["the settings list is not an array", { list: "development-docs" }],
    ["the link points elsewhere", { link: "elsewhere" as const }],
    ["the folder is tracked", { tracked: true }],
  ])("not shared: %s", (_, o) => {
    const { main, wt } = sharedFixture(o);
    expect(write(wt, "development-docs/K/ledger.md")).toBe("high");
    expect(write(wt, join(main, "development-docs/K/notes.md"))).toBe("high");
  });

  it("a real folder or no entry in the worktree: the main checkout's folder is not shared (a relative Write is inside the cwd)", () => {
    for (const link of ["dir", "none"] as const) {
      const { main, wt } = sharedFixture({ link });
      expect(write(wt, join(main, "development-docs/K/notes.md"))).toBe("high");
      expect(sharedDirs(wt)).toEqual([]);
    }
  });

  it("an entry outside the repository, absolute or with .. is ignored", () => {
    const f = sharedFixture({ list: ["../x", "/tmp", "development-docs/../.."] });
    expect(sharedDirs(f.wt)).toEqual([]);
    expect(write(f.wt, "development-docs/K/ledger.md")).toBe("high");
  });

  it.each([
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks/x",
    ".claude/agents/x.md",
    ".claude/commands/x.md",
    ".claude/skills/x/SKILL.md",
  ])("deny holds in the worktree: %s", (p) => {
    const { wt } = sharedFixture();
    expect(write(wt, p)).toBe("high");
  });

  it.each(["development-docs/.claude/x", "development-docs/K/.claude/settings.json", "development-docs/.env", "development-docs/sub/.git/config", "development-docs/.gitconfig", "development-docs/hooks/pre-commit", "development-docs/K/id.pem", "development-docs/~/x"])("deny holds in the shared folder: %s", (p) => {
    const { main, wt } = sharedFixture();
    expect(write(wt, p)).toBe("high");
    expect(write(wt, join(main, p))).toBe("high");
  });

  it("a symlink inside the shared folder to an outside file is high", () => {
    const { main, wt, shared } = sharedFixture();
    writeFileSync(join(main, "secret.txt"), "s");
    symlinkSync(join(main, "secret.txt"), join(shared, "K", "out"));
    expect(write(wt, "development-docs/K/out")).toBe("high");
  });

  it("a nested repository in the shared folder is high", () => {
    const { wt, shared } = sharedFixture();
    mkdirSync(join(shared, "clone"));
    fixtureGit(join(shared, "clone"), "init", "-q");
    expect(write(wt, "development-docs/clone/x.ts")).toBe("high");
    expect(write(wt, "development-docs/clone/sub/x.ts")).toBe("high");
    expect(write(wt, "development-docs/K/x.ts")).toBe("low");
  });

  it("a git config value naming a shared path makes the repository unsafe", () => {
    const { main, wt } = sharedFixture();
    fixtureGit(main, "config", "core.hooksPath", join(main, "development-docs", "h"));
    expect(repoSafety(wt).unsafe).toBe(true);
    expect(write(wt, "development-docs/K/ledger.md")).toBe("high");
    expect(write(wt, "packages/x.ts")).toBe("high");
  });

  it("a config key naming a file in the shared folder protects that path only", () => {
    const { main, wt } = sharedFixture();
    fixtureGit(main, "config", "core.excludesFile", join(main, "development-docs", "K", "ignore"));
    expect(repoSafety(wt).protectedPaths).toContain(join(main, "development-docs", "K", "ignore"));
    expect(write(wt, "development-docs/K/ignore")).toBe("high");
    expect(write(wt, "development-docs/K/ledger.md")).toBe("low");
  });

  it("the main checkout as cwd: no shared folder (its nested worktree makes it unsafe, as before)", () => {
    const { main } = sharedFixture();
    expect(write(main, "development-docs/K/a.md")).toBe("high");
    expect(sharedDirs(main)).toEqual([]);
  });

  it("repoSafety reports a tracked shared folder", () => {
    expect(repoSafety(sharedFixture().wt).trackedShared).toEqual([]);
    expect(repoSafety(sharedFixture({ tracked: true }).wt).trackedShared).toEqual(["development-docs"]);
  });
});
