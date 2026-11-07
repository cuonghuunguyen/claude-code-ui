import { describe, expect, it } from "vitest";
import { editorLabel, parseEditorCommand } from "@claude-ui/protocol";
import { customCommand, detectEditors, findOnPath, openCommand } from "../src/open-external.ts";

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
    expect(openCommand("win32", "default", "C:\\p\\a & b.pdf", "C:\\p", false)).toEqual({ cmd: "explorer.exe", args: ['"C:\\p\\a & b.pdf"'], verbatim: true, ignoreExit: true });
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
  it("WSL: reveal and default go to Windows Explorer with the Windows path as one argument", () => {
    const w = "\\\\wsl.localhost\\Ubuntu\\p\\a b\\ä.txt";
    expect(openCommand("linux", "reveal", "/p/a b/ä.txt", "/p", false, undefined, w)).toEqual({ cmd: "explorer.exe", args: ["/select," + w], ignoreExit: true });
    expect(openCommand("linux", "reveal", "/p/d", "/p", true, undefined, w)).toEqual({ cmd: "explorer.exe", args: ["/select," + w], ignoreExit: true });
    expect(openCommand("linux", "default", "/p/a.pdf", "/p", false, undefined, w)).toEqual({ cmd: "explorer.exe", args: [w], ignoreExit: true });
    expect(() => openCommand("linux", "default", "/p/d", "/p", true, undefined, w)).toThrow(/folder/);
  });
  it("WSL: an editor keeps the POSIX paths", () => {
    expect(openCommand("linux", "code", "/p/a.ts", "/p", false, { cli: "/bin/code" }, "\\\\wsl.localhost\\U\\p\\a.ts")).toEqual({ cmd: "/bin/code", args: ["/p", "/p/a.ts"] });
  });
});

describe("custom editor command (GH-646)", () => {
  const found = (n: string) => (n.startsWith("/") || n.startsWith("C:") ? n : "/usr/bin/" + n);
  it("parseEditorCommand: words, quotes, unbalanced", () => {
    expect(parseEditorCommand('subl  {root} "{path}"')).toEqual(["subl", "{root}", "{path}"]);
    expect(parseEditorCommand('"C:\\Program Files\\S\\subl.exe" --a="b c"')).toEqual(["C:\\Program Files\\S\\subl.exe", "--a=b c"]);
    expect(parseEditorCommand('a "" b')).toEqual(["a", "", "b"]);
    expect(parseEditorCommand('a "b')).toEqual([]);
    expect(parseEditorCommand("  ")).toEqual([]);
  });
  it("appends the paths without placeholders: file → root path, folder → path", () => {
    expect(customCommand(["subl"], "/p/a.ts", "/p", false, "linux", found)).toEqual({ cmd: "/usr/bin/subl", args: ["/p", "/p/a.ts"] });
    expect(customCommand(["subl", "-n"], "/p/d", "/p", true, "linux", found)).toEqual({ cmd: "/usr/bin/subl", args: ["-n", "/p/d"] });
  });
  it("replaces {path} and {root} inside an argument, appends nothing", () => {
    expect(customCommand(["subl", "--goto={path}", "{root}"], "/p/a.ts", "/p", false, "linux", found)).toEqual({ cmd: "/usr/bin/subl", args: ["--goto=/p/a.ts", "/p"] });
  });
  it("a file name holding {root} is not replaced again", () => {
    expect(customCommand(["e", "{path}"], "/p/n-{root}.md", "/p", false, "linux", found).args).toEqual(["/p/n-{root}.md"]);
  });
  it("shell metacharacters stay literal in argv", () => {
    const p = "/p/a;b|c&$(x)`y`'z.ts";
    expect(customCommand(["e", "{path}"], p, "/p", false, "linux", found).args).toEqual([p]);
  });
  it("not found: editor_missing; Windows .cmd: cmd.exe with quoted arguments, % refused", () => {
    expect(() => customCommand(["nope"], "/p/a", "/p", false, "linux", () => undefined)).toThrow(/not found: nope/);
    expect(customCommand(["ed", "{path}"], "C:\\p\\a & b.ts", "C:\\p", false, "win32", () => "C:\\bin\\ed.cmd")).toEqual({ cmd: "cmd.exe", args: ["/d", "/s", "/c", '""C:\\bin\\ed.cmd" "C:\\p\\a & b.ts""'], verbatim: true });
    expect(() => customCommand(["ed", "{path}"], "C:\\p\\%X%.ts", "C:\\p", false, "win32", () => "C:\\bin\\ed.cmd")).toThrow(/%/);
  });
  it("findOnPath: PATH search with PATHEXT, absolute path as is", () => {
    const o = { platform: "win32" as const, env: { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" }, exists: (p: string) => p === "C:\\b\\ed.cmd" || p === "C:\\x\\y.exe" };
    expect(findOnPath(o, "ed")).toBe("C:\\b\\ed.cmd");
    expect(findOnPath(o, "C:\\x\\y.exe")).toBe("C:\\x\\y.exe");
    expect(findOnPath({ ...o, platform: "linux", env: { PATH: "/a:/b" }, exists: (p) => p === "/b/ed" }, "ed")).toBe("/b/ed");
  });
  it("editorLabel: name, else program name without folder and extension", () => {
    expect(editorLabel({ command: '"C:\\Sublime Text\\subl.exe" {path}', name: "" })).toBe("subl");
    expect(editorLabel({ command: "/usr/bin/subl", name: "S" })).toBe("S");
  });
});
