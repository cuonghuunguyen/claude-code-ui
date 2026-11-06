import { describe, expect, it } from "vitest";
import { detectEditors, openCommand } from "../src/open-external.ts";

const cli = { cli: "/bin/code" };
describe("openCommand", () => {
  it("reveal", () => {
    expect(openCommand("darwin", "reveal", "/p/a b.txt", "/p", false)).toEqual({ cmd: "open", args: ["-R", "/p/a b.txt"] });
    expect(openCommand("win32", "reveal", "C:\\p\\a b.txt", "C:\\p", false)).toEqual({ cmd: "explorer.exe", args: ['/select,"C:\\p\\a b.txt"'], verbatim: true, ignoreExit: true });
    expect(openCommand("linux", "reveal", "/p/a.txt", "/p", false)).toEqual({ cmd: "xdg-open", args: ["/p"] });
    expect(openCommand("linux", "reveal", "/p/dir", "/p", true)).toEqual({ cmd: "xdg-open", args: ["/p/dir"] });
  });
  it("default app: files only", () => {
    expect(openCommand("darwin", "default", "/p/a.pdf", "/p", false)).toEqual({ cmd: "open", args: ["/p/a.pdf"] });
    expect(openCommand("win32", "default", "C:\\p\\a & b.pdf", "C:\\p", false)).toEqual({ cmd: "explorer.exe", args: ["C:\\p\\a & b.pdf"] });
    expect(openCommand("linux", "default", "/p/a.pdf", "/p", false)).toEqual({ cmd: "xdg-open", args: ["/p/a.pdf"] });
    expect(() => openCommand("linux", "default", "/p/d", "/p", true)).toThrow(/folder/);
  });
  it("editor: file beside its root, folder alone, app bundle through open -a", () => {
    expect(openCommand("linux", "code", "/p/a.ts", "/p", false, cli)).toEqual({ cmd: "/bin/code", args: ["/p", "/p/a.ts"] });
    expect(openCommand("linux", "code", "/p/d", "/p", true, cli)).toEqual({ cmd: "/bin/code", args: ["/p/d"] });
    expect(openCommand("darwin", "cursor", "/p/a.ts", "/p", false, { app: "/Applications/Cursor.app" })).toEqual({ cmd: "open", args: ["-a", "/Applications/Cursor.app", "/p", "/p/a.ts"] });
    expect(() => openCommand("linux", "idea", "/p/a.ts", "/p", false)).toThrow(/not installed/);
  });
  it("Windows .cmd launcher: cmd.exe with quoted arguments; % refused; .exe direct", () => {
    expect(openCommand("win32", "code", "C:\\p\\a & b.ts", "C:\\p", false, { cli: "C:\\bin\\code.cmd" })).toEqual({
      cmd: "cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\bin\\code.cmd" "C:\\p" "C:\\p\\a & b.ts""'],
      verbatim: true,
    });
    expect(() => openCommand("win32", "code", "C:\\p\\%PATH%.ts", "C:\\p", false, { cli: "C:\\bin\\code.cmd" })).toThrow(/%/);
    expect(openCommand("win32", "idea", "C:\\p\\a.ts", "C:\\p", false, { cli: "C:\\bin\\idea64.exe" })).toEqual({ cmd: "C:\\bin\\idea64.exe", args: ["C:\\p", "C:\\p\\a.ts"] });
  });
});

describe("detectEditors", () => {
  const has = (...f: string[]) => (p: string) => f.includes(p);
  it("finds the CLI on PATH", () => {
    const m = detectEditors({ platform: "linux", env: { PATH: "/x:/usr/bin" }, exists: has("/usr/bin/code"), home: "/h" });
    expect([...m]).toEqual([["code", { cli: "/usr/bin/code" }]]);
  });
  it("Windows: PATHEXT", () => {
    const m = detectEditors({ platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" }, exists: has("C:\\bin\\cursor.cmd"), home: "C:\\h" });
    expect(m.get("cursor")).toEqual({ cli: "C:\\bin\\cursor.cmd" });
  });
  it("macOS: app bundle when the CLI is not on PATH", () => {
    const m = detectEditors({ platform: "darwin", env: { PATH: "/usr/bin" }, exists: has("/h/Applications/IntelliJ IDEA CE.app", "/Applications/Cursor.app"), home: "/h" });
    expect([...m]).toEqual([["cursor", { app: "/Applications/Cursor.app" }], ["idea", { app: "/h/Applications/IntelliJ IDEA CE.app" }]]);
  });
  it("none", () => expect(detectEditors({ platform: "linux", env: {}, exists: () => false, home: "/h" }).size).toBe(0));
});
