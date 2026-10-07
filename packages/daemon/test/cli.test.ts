import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP, parseCli } from "../src/cli.ts";

describe("parseCli", () => {
  it("defaults: port 4280, home root, no hostname, bypass off", () => {
    const r = parseCli([], {}, "/home/u");
    expect(r).toEqual({ kind: "run", port: 4280, roots: ["/home/u"], hostname: undefined, lan: false, allowBypass: false, idleCloseMinutes: 10 });
  });
  it("env vars keep working", () => {
    const env = { PORT: "5000", CLAUDE_UI_ROOTS: ["/a", "/b"].join(delimiter), CLAUDE_UI_HOSTNAME: "m.ts.net", CLAUDE_UI_ALLOW_BYPASS: "1" };
    expect(parseCli([], env, "/h")).toEqual({ kind: "run", port: 5000, roots: ["/a", "/b"], hostname: "m.ts.net", lan: false, allowBypass: true, idleCloseMinutes: 10 });
  });
  it("flags override env", () => {
    const r = parseCli(["--port", "6000", "--roots", "/x", "--hostname", "h", "--lan", "--allow-bypass"], { PORT: "5000", CLAUDE_UI_ROOTS: "/a" }, "/h");
    expect(r).toEqual({ kind: "run", port: 6000, roots: ["/x"], hostname: "h", lan: true, allowBypass: true, idleCloseMinutes: 10 });
    expect(parseCli([], { CLAUDE_UI_LAN: "1" }, "/h")).toMatchObject({ lan: true });
  });
  it("--tailscale and its env var; conflict with a hostname", () => {
    expect(parseCli(["--tailscale"], {}, "/h")).toMatchObject({ kind: "run", tailscale: true });
    expect(parseCli([], { CLAUDE_UI_TAILSCALE: "1" }, "/h")).toMatchObject({ tailscale: true });
    expect(parseCli([], {}, "/h")).not.toHaveProperty("tailscale");
    expect(parseCli(["--tailscale", "--hostname", "x"], {}, "/h")).toMatchObject({ kind: "error", message: expect.stringContaining("--tailscale sets the hostname") });
    expect(parseCli(["--tailscale"], { CLAUDE_UI_HOSTNAME: "x" }, "/h").kind).toBe("error");
    expect(HELP).toContain("--tailscale");
  });
  it("help and version short-circuit", () => {
    expect(parseCli(["--help"], {}, "/h").kind).toBe("help");
    expect(parseCli(["-h"], {}, "/h").kind).toBe("help");
    expect(parseCli(["--version"], {}, "/h").kind).toBe("version");
    expect(parseCli(["-v"], {}, "/h").kind).toBe("version");
  });
  it("update subcommand and --no-update-check", () => {
    expect(parseCli(["update"], {}, "/h")).toEqual({ kind: "update" });
    expect(parseCli(["update", "x"], {}, "/h").kind).toBe("error");
    expect(parseCli(["--no-update-check"], {}, "/h")).toMatchObject({ kind: "run", updateCheck: false });
    expect(parseCli([], { CLAUDE_UI_UPDATE_CHECK: "0" }, "/h")).toMatchObject({ updateCheck: false });
    expect(parseCli([], {}, "/h")).not.toHaveProperty("updateCheck");
  });
  it("rejects an invalid port, an unknown flag and a stray argument", () => {
    for (const argv of [["--port", "abc"], ["--port", "70000"], ["--nope"], ["extra"]]) expect(parseCli(argv, {}, "/h").kind).toBe("error");
    expect(parseCli([], { PORT: "x" }, "/h").kind).toBe("error");
  });

  it("--no-os-notify / CLAUDE_UI_OS_NOTIFY=0 turn the desktop notification off", () => {
    expect(parseCli(["--no-os-notify"], {}, "/h")).toMatchObject({ kind: "run", osNotify: false });
    expect(parseCli([], { CLAUDE_UI_OS_NOTIFY: "0" }, "/h")).toMatchObject({ kind: "run", osNotify: false });
    expect(parseCli([], {}, "/h")).not.toHaveProperty("osNotify");
    expect(HELP).toContain("--no-os-notify");
  });

  it("CLAUDE_UI_IDLE_CLOSE_MINUTES sets the idle close; default 10; invalid is an error", () => {
    expect(parseCli([], {}, "/h")).toMatchObject({ idleCloseMinutes: 10 });
    expect(parseCli([], { CLAUDE_UI_IDLE_CLOSE_MINUTES: "0" }, "/h")).toMatchObject({ idleCloseMinutes: 0 });
    expect(parseCli([], { CLAUDE_UI_IDLE_CLOSE_MINUTES: "3" }, "/h")).toMatchObject({ idleCloseMinutes: 3 });
    expect(parseCli([], { CLAUDE_UI_IDLE_CLOSE_MINUTES: "-1" }, "/h")).toEqual({ kind: "error", message: "invalid CLAUDE_UI_IDLE_CLOSE_MINUTES: -1" });
    expect(parseCli([], { CLAUDE_UI_IDLE_CLOSE_MINUTES: "x" }, "/h")).toMatchObject({ kind: "error" });
  });
});
