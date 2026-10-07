import { describe, expect, it } from "vitest";
import { baseName, inDir, isWinPath, joinPath, relPath, withSep } from "./paths.ts";

describe("paths (POSIX and Windows daemon)", () => {
  it("a drive letter or UNC path is a Windows path", () => {
    expect([isWinPath("C:\\Users\\me"), isWinPath("c:/x"), isWinPath("\\\\srv\\share"), isWinPath("/home/me"), isWinPath("src/a.ts")]).toEqual([true, true, true, false, false]);
  });

  it("baseName takes the last segment on either separator", () => {
    expect(baseName("/home/me/proj")).toBe("proj");
    expect(baseName("/home/me/proj/")).toBe("proj");
    expect(baseName("C:\\Users\\me\\proj")).toBe("proj");
    expect(baseName("src\\package.json")).toBe("package.json");
    expect(baseName("C:\\")).toBe("C:");
  });

  it("inDir: POSIX is case-sensitive; Windows ignores case and takes either separator", () => {
    expect(inDir("/p/x/a.ts", "/p/x")).toBe(true);
    expect(inDir("/p/xy/a.ts", "/p/x")).toBe(false);
    expect(inDir("/P/x/a.ts", "/p/x")).toBe(false);
    expect(inDir("c:\\users\\ME\\proj\\a.ts", "C:\\Users\\me\\proj")).toBe(true);
    expect(inDir("C:/Users/me/proj/src/a.ts", "C:\\Users\\me\\proj")).toBe(true);
    expect(inDir("C:\\Users\\me\\project\\a.ts", "C:\\Users\\me\\proj")).toBe(false);
    expect(inDir("C:\\a.ts", "C:\\")).toBe(true);
  });

  it("relPath: relative inside cwd (Windows keeps its own separators), unchanged outside", () => {
    expect(relPath("/p/x/src/a.ts", "/p/x")).toBe("src/a.ts");
    expect(relPath("/p/x/src/a.ts", "/p/x/")).toBe("src/a.ts");
    expect(relPath("/q/a.ts", "/p/x")).toBe("/q/a.ts");
    expect(relPath("C:\\Users\\me\\proj\\src\\a.ts", "C:\\Users\\me\\proj")).toBe("src\\a.ts");
    expect(relPath("c:\\users\\me\\proj\\a.ts", "C:\\Users\\me\\proj")).toBe("a.ts");
    expect(relPath("D:\\x\\a.ts", "C:\\Users\\me\\proj")).toBe("D:\\x\\a.ts");
  });

  it("joinPath and withSep use the separator of the absolute path", () => {
    expect(joinPath("/p/x/", "src/a.ts")).toBe("/p/x/src/a.ts");
    expect(joinPath("C:\\Users\\me\\proj", "src/a.ts")).toBe("C:\\Users\\me\\proj\\src\\a.ts");
    expect(withSep("/p/x")).toBe("/p/x/");
    expect(withSep("/p/x/")).toBe("/p/x/");
    expect(withSep("C:\\Users")).toBe("C:\\Users\\");
    expect(withSep("C:\\")).toBe("C:\\");
  });
});
