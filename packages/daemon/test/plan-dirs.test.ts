import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localSettingsFiles } from "../src/local-settings.ts";
import { planDirs } from "../src/plan-dirs.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "plan-dirs-"));
const settings = (dir: string, json: unknown, name = "settings.json") => (mkdirSync(dir, { recursive: true }), writeFileSync(join(dir, name), JSON.stringify(json)));

const own = (cwd: string) => [join(cwd, ".claude", "settings.local.json")];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd, stdio: "pipe" });

describe("planDirs (the CLI's plan folders)", () => {
  it("the plansDirectory setting (local over project over user) comes first, relative to the project, and the default stays listed", () => {
    const claude = tmp();
    const cwd = tmp();
    settings(claude, { plansDirectory: "user-plans" });
    expect(planDirs(claude, cwd, own(cwd))).toEqual([join(cwd, "user-plans"), join(claude, "plans")]);
    settings(join(cwd, ".claude"), { plansDirectory: "docs/plans" });
    expect(planDirs(claude, cwd, own(cwd))).toEqual([join(cwd, "docs", "plans"), join(claude, "plans")]);
    settings(join(cwd, ".claude"), { plansDirectory: "local-plans" }, "settings.local.json");
    expect(planDirs(claude, cwd, own(cwd))[0]).toBe(join(cwd, "local-plans"));
  });

  it("a plansDirectory outside the project is ignored, like the CLI does", () => {
    const claude = tmp();
    const cwd = tmp();
    settings(join(cwd, ".claude"), { plansDirectory: "../elsewhere" });
    expect(planDirs(claude, cwd, own(cwd))).toEqual([join(claude, "plans")]);
    settings(join(cwd, ".claude"), { plansDirectory: "/etc/plans" });
    expect(planDirs(claude, cwd, own(cwd))).toEqual([join(claude, "plans")]);
  });

  it.skipIf(process.platform === "win32")("a session in a linked worktree reads the main checkout's local file, which wins over the worktree's own", async () => {
    const claude = tmp();
    const main = realpathSync(tmp());
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(realpathSync(tmp()), "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    settings(join(main, ".claude"), { plansDirectory: "docs/plans" }, "settings.local.json");
    expect(planDirs(claude, wt, await localSettingsFiles(wt))).toEqual([join(wt, "docs", "plans"), join(claude, "plans")]);
    settings(join(wt, ".claude"), { plansDirectory: "own-plans" }, "settings.local.json");
    expect(planDirs(claude, wt, await localSettingsFiles(wt))[0]).toBe(join(wt, "docs", "plans"));
    settings(join(main, ".claude"), {}, "settings.local.json");
    expect(planDirs(claude, wt, await localSettingsFiles(wt))[0]).toBe(join(wt, "own-plans"));
  });
});
