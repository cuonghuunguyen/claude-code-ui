import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readDefaultMode } from "../src/default-mode.ts";
import { localSettingsFiles } from "../src/local-settings.ts";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "default-mode-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=a@example.com", "-c", "user.name=a", ...args], { cwd, stdio: "pipe" });
const write = (file: string, mode: string) => (mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, JSON.stringify({ permissions: { defaultMode: mode } })));
const local = (dir: string) => join(dir, ".claude", "settings.local.json");

describe.skipIf(process.platform === "win32")("readDefaultMode in a linked worktree", () => {
  const setup = () => {
    const main = tmp();
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(tmp(), "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "feature");
    return { main, wt, claude: tmp() };
  };

  it("reads the main checkout's local file, as the CLI does", async () => {
    const t = setup();
    write(local(t.main), "plan");
    expect(readDefaultMode(t.claude, t.wt, await localSettingsFiles(t.wt))).toBe("plan");
  });

  it("the main checkout's value wins over the worktree's own file, which fills when the main file sets none", async () => {
    const t = setup();
    write(local(t.main), "acceptEdits");
    write(local(t.wt), "plan");
    expect(readDefaultMode(t.claude, t.wt, await localSettingsFiles(t.wt))).toBe("acceptEdits");
    writeFileSync(local(t.main), "{}");
    expect(readDefaultMode(t.claude, t.wt, await localSettingsFiles(t.wt))).toBe("plan");
  });
});
