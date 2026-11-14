import { expect, it } from "vitest";
import { HARDEN, tagCreateArgv, tagDeleteArgv, tagDeleteRemoteArgv } from "../src/git-argv.ts";

const hash = "a".repeat(40);

it("tagCreateArgv: lightweight without a message, annotated with text", () => {
  expect(tagCreateArgv("v1", hash)).toEqual(["tag", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "")).toEqual(["tag", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "  \n ")).toEqual(["tag", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "release one")).toEqual(["tag", "-a", "-m", "release one", "v1", hash]);
});

it("tagCreateArgv: sign true signs (-s, the message defaults to the name), sign false overrides tag.gpgSign", () => {
  expect(tagCreateArgv("v1", hash, undefined, true)).toEqual(["tag", "-s", "-m", "v1", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "  ", true)).toEqual(["tag", "-s", "-m", "v1", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "release one", true)).toEqual(["tag", "-s", "-m", "release one", "v1", hash]);
  expect(tagCreateArgv("v1", hash, undefined, false)).toEqual(["tag", "--no-sign", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "release one", false)).toEqual(["tag", "-a", "--no-sign", "-m", "release one", "v1", hash]);
  expect(tagCreateArgv("v1", hash, "release one", undefined)).toEqual(["tag", "-a", "-m", "release one", "v1", hash]);
});

it("tagDeleteArgv", () => {
  expect(tagDeleteArgv("v1")).toEqual(["tag", "-d", "v1"]);
});

it("tagDeleteRemoteArgv: hardened push with a lease on the shown hash", () => {
  expect(tagDeleteRemoteArgv("origin", "v1", hash)).toEqual([...HARDEN, "push", "--no-recurse-submodules", `--force-with-lease=refs/tags/v1:${hash}`, "origin", "--delete", "refs/tags/v1"]);
});
