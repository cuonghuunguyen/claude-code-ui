import { describe, expect, it } from "vitest";
import type { FsEntry } from "@claude-ui/protocol";
import { browse, matchFolders } from "./folders.ts";

const roots = ["/home/u", "/srv"];
const dir = (name: string): FsEntry => ({ name, path: `/x/${name}`, isDir: true });

describe("browse", () => {
  it("lists the typed directory and filters by the segment after the last slash", () => {
    expect(browse("/home/u/", roots)).toEqual({ dir: "/home/u", prefix: "" });
    expect(browse("/home/u/proj/cl", roots)).toEqual({ dir: "/home/u/proj", prefix: "cl" });
    expect(browse("/home/u", roots)).toEqual({ dir: "/home/u", prefix: "" });
  });

  it("outside every root it lists the roots, filtered by the whole input", () => {
    expect(browse("", roots)).toEqual({ prefix: "" });
    expect(browse("/sr", roots)).toEqual({ prefix: "/sr" });
    expect(browse("/home/user2/x", roots)).toEqual({ prefix: "/home/user2/x" });
  });
});

describe("matchFolders", () => {
  const entries = [dir("web"), dir(".git"), { name: "README.md", path: "/x/README.md", isDir: false }, dir("Claude-ui"), dir("api")];

  it("keeps folders whose name starts with the prefix (case-insensitive), dot folders only when typed", () => {
    expect(matchFolders(entries, "").map((e) => e.name)).toEqual(["web", "Claude-ui", "api"]);
    expect(matchFolders(entries, "cl").map((e) => e.name)).toEqual(["Claude-ui"]);
    expect(matchFolders(entries, ".").map((e) => e.name)).toEqual([".git"]);
  });

  it("then folders that contain it", () => {
    expect(matchFolders([dir("my-api"), dir("api")], "api").map((e) => e.name)).toEqual(["api", "my-api"]);
  });
});
