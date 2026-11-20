import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProjectOverrides } from "@claude-ui/protocol";
import { historySettings, inlineTaskSettings, projectOverrides, projectOverridesOfFile } from "../src/project-overrides.ts";
import { createLocalHistory } from "../src/local-history.ts";
import { parseSettings } from "../src/settings.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "po-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd, stdio: "pipe" });
const settings = (local: Record<string, ProjectOverrides>) => parseSettings({ projects: { overrides: { local } } });

describe("projectOverrides", () => {
  it("unset gives nothing (the global value applies), set gives the override, cleared gives nothing again", () => {
    expect(projectOverrides(settings({}), "/p")).toEqual({});
    expect(projectOverrides(settings({ "/p": { mode: "plan" } }), "/p")).toEqual({ mode: "plan" });
    expect(projectOverrides(settings({ "/p": { mode: "plan" } }), "/other")).toEqual({});
    expect(projectOverrides(settings({}), "/p")).toEqual({});
  });

  it("only this daemon's entries count: another Side's key is not a local Project", () => {
    expect(projectOverrides(parseSettings({ projects: { overrides: { "ssh:box": { "/p": { mode: "plan" } } } } }), "/p")).toEqual({});
  });

  it("a key named like an Object property is data, not a prototype", () => {
    expect(projectOverrides(settings({}), "__proto__")).toEqual({});
    expect(projectOverrides(parseSettings({ projects: { overrides: JSON.parse('{"__proto__":{"/p":{"mode":"plan"}}}') } }), "/p")).toEqual({});
  });

  it("a folder that is not a git repository gives nothing and does not throw", () => {
    const dir = tmp();
    expect(projectOverrides(settings({ "/p": { mode: "plan" } }), dir)).toEqual({});
  });

  describe.skipIf(process.platform === "win32")("Worktrees", () => {
    const repo = () => {
      const main = tmp();
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "init");
      const wt = join(tmp(), "wt");
      git(main, "worktree", "add", "-q", wt, "-b", "feature");
      return { main, wt };
    };

    it("a linked Worktree uses the values of its main checkout's Project", () => {
      const { main, wt } = repo();
      expect(projectOverrides(settings({ [main]: { mode: "acceptEdits", history: { enabled: false } } }), wt)).toEqual({ mode: "acceptEdits", history: { enabled: false } });
    });

    it("the Worktree's own entry wins over the main checkout's", () => {
      const { main, wt } = repo();
      expect(projectOverrides(settings({ [main]: { mode: "plan" }, [wt]: { mode: "auto" } }), wt)).toEqual({ mode: "auto" });
    });

    it("a Worktree of a bare repository gives nothing", () => {
      const bare = join(tmp(), "bare.git");
      const seed = tmp();
      git(seed, "init", "-q");
      git(seed, "commit", "-q", "--allow-empty", "-m", "init");
      git(seed, "clone", "-q", "--bare", seed, bare);
      const wt = join(tmp(), "wt");
      git(bare, "worktree", "add", "-q", wt, "-b", "feature");
      // The folder that holds the bare repository is no Project of it.
      expect(projectOverrides(settings({ [join(bare, "..")]: { mode: "plan" } }), wt)).toEqual({});
    });

    it("a file takes the override of the nearest Project above it, through a Worktree too", () => {
      const { main, wt } = repo();
      mkdirSync(join(wt, "src"));
      writeFileSync(join(wt, "src", "a.ts"), "x");
      const s = settings({ [main]: { history: { enabled: false } } });
      expect(projectOverridesOfFile(s, join(wt, "src", "a.ts"))).toEqual({ history: { enabled: false } });
      expect(projectOverridesOfFile(s, join(main, "b.ts"))).toEqual({ history: { enabled: false } });
      expect(projectOverridesOfFile(s, join(tmp(), "c.ts"))).toEqual({});
    });
  });
});

describe("readers", () => {
  it("inline task: the Project's models replace the global ones, unset ones stay, other Projects are unchanged", () => {
    const s = settings({ "/a": { inlineTask: { model: "sonnet" } }, "/b": { inlineTask: { openCodeModel: "deepseek/flash" } } });
    expect(inlineTaskSettings(s, "/a")).toEqual({ enabled: true, model: "sonnet", openCodeModel: "", maxTurns: 10 });
    expect(inlineTaskSettings(s, "/b")).toEqual({ enabled: true, model: "haiku", openCodeModel: "deepseek/flash", maxTurns: 10 });
    expect(inlineTaskSettings(s, "/c")).toEqual(s.inlineTask);
  });

  it("local history: the Project override of enabled decides per file, both ways; exclude stays global", () => {
    const off = settings({ "/a": { history: { enabled: false } } });
    expect(historySettings(off, "/a/x.ts").enabled).toBe(false);
    expect(historySettings(off, "/b/x.ts").enabled).toBe(true);
    expect(historySettings(off, "/a/x.ts").exclude).toEqual(off.history.exclude);
    const on = parseSettings({ history: { enabled: false }, projects: { overrides: { local: { "/a": { history: { enabled: true } } } } } });
    expect(historySettings(on, "/a/x.ts").enabled).toBe(true);
    expect(historySettings(on, "/b/x.ts").enabled).toBe(false);
  });

  it("local history takes no snapshot for a file of a Project that turned it off", async () => {
    const root = tmp();
    const off = join(root, "off");
    const on = join(root, "on");
    mkdirSync(off);
    mkdirSync(on);
    writeFileSync(join(off, "a.txt"), "v0");
    writeFileSync(join(on, "a.txt"), "v0");
    const s = settings({ [off]: { history: { enabled: false } } });
    const h = createLocalHistory({ dir: join(root, "history"), settings: (path) => historySettings(s, path), allowed: (p) => p });
    h.before(join(off, "a.txt"), "save");
    h.before(join(on, "a.txt"), "save");
    expect(await h.list(join(off, "a.txt"))).toHaveLength(0);
    expect(await h.list(join(on, "a.txt"))).toHaveLength(1);
  });
});
