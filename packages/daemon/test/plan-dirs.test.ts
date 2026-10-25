import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planDirs } from "../src/plan-dirs.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "plan-dirs-"));
const settings = (dir: string, json: unknown, name = "settings.json") => (mkdirSync(dir, { recursive: true }), writeFileSync(join(dir, name), JSON.stringify(json)));

describe("planDirs (the CLI's plan folders)", () => {
  it("is <config dir>/plans, the CLAUDE_CONFIG_DIR folder the daemon was given", () => {
    const claude = tmp();
    expect(planDirs(claude, tmp())).toEqual([join(claude, "plans")]);
  });

  it("the plansDirectory setting (local over project over user) comes first, relative to the project, and the default stays listed", () => {
    const claude = tmp();
    const cwd = tmp();
    settings(claude, { plansDirectory: "user-plans" });
    expect(planDirs(claude, cwd)).toEqual([join(cwd, "user-plans"), join(claude, "plans")]);
    settings(join(cwd, ".claude"), { plansDirectory: "docs/plans" });
    expect(planDirs(claude, cwd)).toEqual([join(cwd, "docs", "plans"), join(claude, "plans")]);
    settings(join(cwd, ".claude"), { plansDirectory: "local-plans" }, "settings.local.json");
    expect(planDirs(claude, cwd)[0]).toBe(join(cwd, "local-plans"));
  });

  it("a plansDirectory outside the project is ignored, like the CLI does", () => {
    const claude = tmp();
    const cwd = tmp();
    settings(join(cwd, ".claude"), { plansDirectory: "../elsewhere" });
    expect(planDirs(claude, cwd)).toEqual([join(claude, "plans")]);
    settings(join(cwd, ".claude"), { plansDirectory: "/etc/plans" });
    expect(planDirs(claude, cwd)).toEqual([join(claude, "plans")]);
  });
});
