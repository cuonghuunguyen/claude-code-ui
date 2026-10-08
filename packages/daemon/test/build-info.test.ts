import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuildInfo } from "../src/build-info.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "build-"));
const touch = (file: string, whenMs: number) => (writeFileSync(file, "x"), utimesSync(file, whenMs / 1000, whenMs / 1000));

describe("createBuildInfo", () => {
  it("dev: stale after a source file's mtime moves past startedAt, not for a *.test.ts or a file in node_modules", () => {
    const src = tmp();
    mkdirSync(join(src, "node_modules"));
    const started = 1_800_000_000_000;
    touch(join(src, "a.ts"), started - 5000);
    const b = createBuildInfo({ version: "dev", srcDirs: [src], startedAt: started, now: () => 0 });
    expect(b.stale()).toBeUndefined();
    const fresh = () => createBuildInfo({ version: "dev", srcDirs: [src], startedAt: started, now: () => 0 });
    touch(join(src, "a.test.ts"), started + 5000);
    touch(join(src, "node_modules", "x.ts"), started + 5000);
    expect(fresh().stale()).toBeUndefined();
    touch(join(src, "a.ts"), started + 5000);
    expect(fresh().stale()).toMatch(/older than its source checkout.*restart the daemon/);
  });

  it("dev: a missing source folder is not stale", () => {
    expect(createBuildInfo({ version: "dev", srcDirs: [join(tmp(), "gone")], startedAt: 0 }).stale()).toBeUndefined();
  });

  const install = (dir: string, v: string, { complete = true, failed = false } = {}) => {
    const cli = join(dir, v, "node_modules", "claude-code-ui", "dist");
    mkdirSync(cli, { recursive: true });
    if (complete) writeFileSync(join(cli, "cli.js"), "x");
    if (failed) writeFileSync(join(dir, v, "failed-start"), "");
  };

  it("release: stale when a newer complete version is installed, not for an older, an equal, an incomplete or a failed one", () => {
    const dir = tmp();
    install(dir, "0.4.0");
    install(dir, "0.4.1");
    install(dir, "0.5.0", { complete: false });
    install(dir, "0.6.0", { failed: true });
    expect(createBuildInfo({ version: "0.4.1", versionsDir: dir }).stale()).toBeUndefined();
    install(dir, "0.4.2");
    expect(createBuildInfo({ version: "0.4.1", versionsDir: dir }).stale()).toBe("claude-ui 0.4.2 is installed but this daemon still runs 0.4.1; it runs after a restart.");
    expect(createBuildInfo({ version: "0.4.2", versionsDir: dir }).stale()).toBeUndefined();
  });

  it("cached for 10 s", () => {
    const src = tmp();
    const started = 1_800_000_000_000;
    let t = 0;
    const b = createBuildInfo({ version: "dev", srcDirs: [src], startedAt: started, now: () => t });
    expect(b.stale()).toBeUndefined();
    touch(join(src, "a.ts"), started + 5000);
    t = 9_999;
    expect(b.stale()).toBeUndefined();
    t = 10_000;
    expect(b.stale()).toMatch(/older than its source checkout/);
  });
});
