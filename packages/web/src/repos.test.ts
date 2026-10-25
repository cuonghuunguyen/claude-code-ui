import { expect, it } from "vitest";
import type { GitRepo } from "@claude-ui/protocol";
import { defaultRepo, repoDir } from "./repos.ts";

it("repoDir spells the top from the cwd", () => {
  expect(repoDir("/p/ws", "")).toBe("/p/ws");
  expect(repoDir("/p/ws", "api")).toBe("/p/ws/api");
  expect(repoDir("/m/pa", "..")).toBe("/m");
  expect(repoDir("/m/pa", "../x/y")).toBe("/m/x/y");
  expect(repoDir("C:\\w", "a/b")).toBe("C:\\w\\a\\b");
});

it("defaultRepo is the first entry not outside the roots", () => {
  const r = (path: string, outsideRoots?: true): GitRepo => ({ path, rel: path, kind: "nested", ...(outsideRoots && { outsideRoots }) });
  expect(defaultRepo([r("/a", true), r("/b"), r("/c")])?.path).toBe("/b");
  expect(defaultRepo([r("/a", true)])).toBeUndefined();
  expect(defaultRepo([])).toBeUndefined();
});
