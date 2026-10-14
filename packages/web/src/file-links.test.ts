import { expect, it } from "vitest";
import { fileRef, linkRef, resolveIn } from "./file-links.tsx";

it("fileRef accepts relative and absolute paths inside the base, with a line from :N, :N:M, :N-M, #LN and #LN-M", () => {
  expect(fileRef("src/a.ts", "/w")).toEqual({ path: "/w/src/a.ts" });
  expect(fileRef("./src/a.ts:12", "/w")).toEqual({ path: "/w/src/a.ts", line: 12 });
  expect(fileRef("src/a.ts#L5-9", "/w")).toEqual({ path: "/w/src/a.ts", line: 5 });
  expect(fileRef("src/a.ts#L5-L9", "/w")).toEqual({ path: "/w/src/a.ts", line: 5 });
  expect(fileRef("/w/in/cwd.ts:3:1", "/w")).toEqual({ path: "/w/in/cwd.ts", line: 3 });
  expect(fileRef("a.ts:7-9", "/w")).toEqual({ path: "/w/a.ts", line: 7 });
  expect(fileRef("app.tsx", "/w")).toEqual({ path: "/w/app.tsx" });
  expect(fileRef("README.md", "/w/")).toEqual({ path: "/w/README.md" });
  expect(fileRef("docs/Dockerfile.dev", "/w")).toEqual({ path: "/w/docs/Dockerfile.dev" });
  expect(fileRef("src\\a.ts:2", "C:\\w")).toEqual({ path: "C:\\w\\src\\a.ts", line: 2 });
  expect(fileRef("c:\\W\\x\\a.ts", "C:\\w")).toEqual({ path: "c:\\W\\x\\a.ts" });
});

it("fileRef rejects code and prose: process.env, JSON.parse, e.g, URLs, .. paths, paths outside the root, spaces, no extension", () => {
  for (const t of ["process.env", "JSON.parse", "e.g", "https://x/y.ts", "../out.ts", "a/../b.ts", "/other/x.ts", "a b.ts", "Makefile", "src/Makefile", "-rf.ts", "@scope/pkg.ts", "~/a.ts", "v1.2", "src/1.2", "*.ts", "", "/w", "src/a.ts:0x"])
    expect(fileRef(t, "/w"), t).toBeUndefined();
  expect(fileRef("/w/../x.ts", "/w")).toBeUndefined();
  expect(fileRef("/ww/x.ts", "/w")).toBeUndefined();
});

it("fileRef resolves against a base but stays inside the root (markdown preview)", () => {
  expect(fileRef("./b.md", "/w/docs", "/w")).toEqual({ path: "/w/docs/b.md" });
  expect(fileRef("/w/src/a.ts", "/w/docs", "/w")).toEqual({ path: "/w/src/a.ts" });
  expect(fileRef("/x/a.ts", "/w/docs", "/w")).toBeUndefined();
});

it("resolveIn resolves ./ and .. against the base and refuses what leaves the root", () => {
  expect(resolveIn("img/a.png", "/w/docs", "/w")).toBe("/w/docs/img/a.png");
  expect(resolveIn("./a%20b.png?x=1", "/w/docs", "/w")).toBe("/w/docs/a b.png");
  expect(resolveIn("../a.png", "/w/docs", "/w")).toBe("/w/a.png");
  expect(resolveIn("../../a.png", "/w/docs", "/w")).toBeUndefined();
  expect(resolveIn("/w/x/a.png", "/w/docs", "/w")).toBe("/w/x/a.png");
  expect(resolveIn("/docs/a.png", "/w/sub", "/w")).toBe("/w/docs/a.png");
  expect(resolveIn("/etc/../../a.png", "/w/docs", "/w")).toBeUndefined();
  expect(resolveIn("..\\a.png", "C:\\w\\docs", "C:\\w")).toBe("C:\\w\\a.png");
});

it("linkRef takes an explicit target as it is: .., a bare name, any extension, #heading, %20, a #LN line", () => {
  expect(linkRef("../README.md", "/w/docs", "/w")).toEqual({ path: "/w/README.md" });
  expect(linkRef("LICENSE", "/w/docs", "/w")).toEqual({ path: "/w/docs/LICENSE" });
  expect(linkRef("logo.png", "/w/docs", "/w")).toEqual({ path: "/w/docs/logo.png" });
  expect(linkRef("setup.md#install", "/w/docs", "/w")).toEqual({ path: "/w/docs/setup.md" });
  expect(linkRef("my%20notes.md", "/w/docs", "/w")).toEqual({ path: "/w/docs/my notes.md" });
  expect(linkRef("a.ts#L7-L9", "/w/docs", "/w")).toEqual({ path: "/w/docs/a.ts", line: 7 });
  expect(linkRef("../../x.md", "/w/docs", "/w")).toBeUndefined();
});
