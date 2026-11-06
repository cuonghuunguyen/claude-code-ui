import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeBin } from "../src/claude-bin.ts";

describe("claudeBin", () => {
  it("resolves an existing file for this platform", () => expect(existsSync(claudeBin())).toBe(true));
  it("throws when no platform package is installed", () => expect(() => claudeBin("plan9" as NodeJS.Platform)).toThrow(/not installed/));
});
