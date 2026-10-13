import { describe, expect, it } from "vitest";
import { foreignPointer, refusedPath, winPathKind } from "../src/remote-path.ts";

describe("winPathKind", () => {
  it.each([
    ["\\\\?\\C:\\x", "device"],
    ["\\\\.\\pipe\\x", "device"],
    ["//?/C:/x", "device"],
    ["//./pipe/x", "device"],
    ["\\??\\UNC\\evil\\s", "device"],
    ["\\\\evil\\share\\x", "unc"],
    ["\\\\.host\\share", "unc"],
    ["\\\\?host\\s", "unc"],
    ["\\\\..\\s", "unc"],
    ["\\\\?", "device"],
    ["//evil/share/x", "unc"],
    ["\\/evil\\share", "unc"],
    ["\\\\wsl$\\Ubuntu\\home", "unc"],
    ["C:\\Users\\me", "other"],
    ["c:/users/me", "other"],
    ["/home/me", "other"],
    ["\\rooted", "other"],
  ])("%s is %s", (p, kind) => expect(winPathKind(p)).toBe(kind));
});

describe("refusedPath (win32)", () => {
  it.each([
    ["\\\\evil\\share\\x", []],
    ["//evil/share/x", []],
    ["\\/evil\\share", []],
    ["\\\\?\\C:\\x", []],
    ["\\\\?\\UNC\\evil\\s", []],
    ["\\\\.\\pipe\\x", []],
    ["//?/C:/x", []],
    ["\\??\\UNC\\evil\\s", []],
    ["\\\\wsl$\\Ubuntu\\home", []],
    ["\\\\.host\\share\\x", []],
    ["\\\\?host\\s\\x", []],
    ["\\\\..\\s\\x", []],
    ["\\\\srv\\proj2\\a", ["\\\\srv\\proj"]],
    ["\\\\?\\UNC\\srv\\proj\\a", ["\\\\srv\\proj"]],
    ["C:\\x\0y", []],
  ])("refuses %j with roots %j", (p, roots) => expect(refusedPath(p, roots, "win32")).toBe(true));

  it.each([
    ["C:\\Users\\me\\a", []],
    ["c:/users/me/a", []],
    ["\\\\srv\\proj\\a", ["\\\\srv\\proj"]],
    ["\\\\SRV\\PROJ\\a", ["\\\\srv\\proj"]],
    ["//srv/proj/a", ["\\\\srv\\proj"]],
    ["\\\\srv\\proj", ["\\\\srv\\proj"]],
    // `..` cannot leave a share: it stays inside the root's share.
    ["\\\\srv\\proj\\..\\other\\x", ["\\\\srv\\proj"]],
    ["\\\\wsl.localhost\\Ubuntu\\home\\me\\p", ["\\\\wsl.localhost\\Ubuntu\\home\\me\\p"]],
  ])("allows %j with roots %j", (p, roots) => expect(refusedPath(p, roots, "win32")).toBe(false));

  it("treats a POSIX path as local", () => {
    expect(refusedPath("/home/me", [], "linux")).toBe(false);
    expect(refusedPath("//evil/share", [], "linux")).toBe(false);
  });
});

describe("foreignPointer", () => {
  it.each([
    ["\\\\evil\\s\\x", "C:\\p", true],
    ["\\\\?\\C:\\x", "C:\\p", true],
    ["\\\\srv\\proj\\.git\\worktrees\\a", "\\\\srv\\proj\\wt", false],
    ["\\\\srv\\other\\x", "\\\\srv\\proj", true],
    ["/home/me/r/.git", "\\\\wsl$\\U\\home\\me\\wt", false],
    ["C:\\r\\.git", "C:\\p", false],
  ])("%s from %s: %s", (v, base, expected) => expect(foreignPointer(v, base, "win32")).toBe(expected));

  it("is false off Windows", () => expect(foreignPointer("\\\\evil\\s\\x", "/p", "linux")).toBe(false));
});
