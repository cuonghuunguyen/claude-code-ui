import { describe, expect, it } from "vitest";
import { followUp, OneShots, retryKey } from "./denied-retry.ts";

describe("retryKey", () => {
  it("Bash: same command = same key, ignoring description, timeout and run_in_background", () => {
    expect(retryKey("Bash", { command: "rm -rf x", description: "a", timeout: 5 })).toBe(retryKey("Bash", { command: "rm -rf x", description: "b", run_in_background: true }));
  });
  it("Bash: another command or tool = another key; PowerShell uses the command too", () => {
    expect(retryKey("Bash", { command: "a" })).not.toBe(retryKey("Bash", { command: "b" }));
    expect(retryKey("Bash", { command: "a" })).not.toBe(retryKey("PowerShell", { command: "a" }));
    expect(retryKey("PowerShell", { command: "a", description: "x" })).toBe(retryKey("PowerShell", { command: "a" }));
  });
  it("other tools: key order and description do not matter, values do", () => {
    expect(retryKey("Write", { file_path: "/a", content: "x", description: "d" })).toBe(retryKey("Write", { content: "x", file_path: "/a" }));
    expect(retryKey("Write", { file_path: "/a", content: "x" })).not.toBe(retryKey("Write", { file_path: "/a", content: "y" }));
    expect(retryKey("Edit", { a: { y: 1, x: 2 } })).toBe(retryKey("Edit", { a: { x: 2, y: 1 } }));
  });
  it("tolerates a non-object input", () => {
    expect(retryKey("Bash", undefined)).toBe(retryKey("Bash", {}));
    expect(retryKey("Foo", "x")).toBe(retryKey("Foo", "x"));
  });
});

describe("followUp", () => {
  it("Bash: names the tool and quotes the command in a fence", () => {
    expect(followUp("Bash", { command: "git push --force" })).toBe("Auto mode denied your Bash call. I allow it once. Run it again with the same input:\n```\ngit push --force\n```");
  });
  it("other tools: input JSON, capped at 4000 characters", () => {
    expect(followUp("Write", { file_path: "/a" })).toContain('"file_path": "/a"');
    const long = followUp("Write", { content: "x".repeat(9000) });
    expect(long).toContain("… (truncated)");
    expect(long.length).toBeLessThan(4300);
  });
  it("a command containing a code fence gets a longer fence", () => {
    expect(followUp("Bash", { command: "echo ```" })).toContain("````\necho ```\n````");
  });
});

describe("OneShots", () => {
  it("take consumes one arming", () => {
    const o = new OneShots();
    o.arm("k");
    expect(o.take("k")).toBe(true);
    expect(o.take("k")).toBe(false);
  });
  it("an unarmed key is not taken; arming twice allows twice; clear drops all; size counts", () => {
    const o = new OneShots();
    expect(o.take("k")).toBe(false);
    o.arm("k");
    o.arm("k");
    expect(o.size).toBe(2);
    expect(o.take("k")).toBe(true);
    expect(o.take("k")).toBe(true);
    o.arm("a");
    o.clear();
    expect(o.size).toBe(0);
    expect(o.take("a")).toBe(false);
  });
});
