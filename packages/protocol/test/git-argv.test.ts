import { expect, it } from "vitest";
import { HARDEN, tagCreateArgv, tagDeleteArgv, tagDeleteRemoteArgv } from "../src/git-argv.ts";

const hash = "a".repeat(40);

it("tagCreateArgv: lightweight without a message, annotated with text", () => {
  expect(tagCreateArgv("v1", hash)).toEqual(["tag", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "")).toEqual(["tag", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "  \n ")).toEqual(["tag", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "release one")).toEqual(["tag", "-a", "-m", "release one", "v1", hash]);
});

it("tagDeleteArgv", () => {
  expect(tagDeleteArgv("v1")).toEqual(["tag", "-d", "v1"]);
});

it("tagDeleteRemoteArgv: hardened push with a lease on the shown hash", () => {
  expect(tagDeleteRemoteArgv("origin", "v1", hash)).toEqual([...HARDEN, "push", "--no-recurse-submodules", `--force-with-lease=refs/tags/v1:${hash}`, "origin", "--delete", "refs/tags/v1"]);
});
