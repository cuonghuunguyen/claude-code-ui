import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.ts";

describe("parseCli", () => {
  it("defaults: port 4280, home root, no hostname, bypass off", () => {
    const r = parseCli([], {}, "/home/u");
    expect(r).toEqual({ kind: "run", port: 4280, roots: ["/home/u"], hostname: undefined, allowBypass: false });
  });
  it("env vars keep working", () => {
    const env = { PORT: "5000", CLAUDE_UI_ROOTS: ["/a", "/b"].join(delimiter), CLAUDE_UI_HOSTNAME: "m.ts.net", CLAUDE_UI_ALLOW_BYPASS: "1" };
    expect(parseCli([], env, "/h")).toEqual({ kind: "run", port: 5000, roots: ["/a", "/b"], hostname: "m.ts.net", allowBypass: true });
  });
  it("flags override env", () => {
    const r = parseCli(["--port", "6000", "--roots", "/x", "--hostname", "h", "--allow-bypass"], { PORT: "5000", CLAUDE_UI_ROOTS: "/a" }, "/h");
    expect(r).toEqual({ kind: "run", port: 6000, roots: ["/x"], hostname: "h", allowBypass: true });
  });
  it("help and version short-circuit", () => {
    expect(parseCli(["--help"], {}, "/h").kind).toBe("help");
    expect(parseCli(["-h"], {}, "/h").kind).toBe("help");
    expect(parseCli(["--version"], {}, "/h").kind).toBe("version");
    expect(parseCli(["-v"], {}, "/h").kind).toBe("version");
  });
  it("rejects an invalid port, an unknown flag and a stray argument", () => {
    for (const argv of [["--port", "abc"], ["--port", "70000"], ["--nope"], ["extra"]]) expect(parseCli(argv, {}, "/h").kind).toBe("error");
    expect(parseCli([], { PORT: "x" }, "/h").kind).toBe("error");
  });
});
