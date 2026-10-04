import { describe, expect, it } from "vitest";
import type { McpServerInfo } from "@claude-ui/protocol";
import { actionsFor, buildAdd, canRemove, errorLine, groupServers, paletteOrder, scopeLabel, statusIcon, statusLabel, type AddForm } from "./mcp.ts";

const s = (name: string, status: string, scope?: string, type = "stdio", extra: Partial<McpServerInfo> = {}): McpServerInfo => ({ name, status, scope, config: { type }, ...extra });

describe("MCP servers dialog logic", () => {
  it("groups by scope in the extension's order, unknown scopes last, names sorted, filtered by name", () => {
    const servers = [s("b", "connected", "user"), s("z", "failed", "dynamic"), s("a", "connected", "user"), s("p", "pending", "project"), s("c", "connected", "claudeai"), s("l", "connected", "local"), s("n", "connected")];
    expect(groupServers(servers).map(([g, l]) => [scopeLabel(g), l.map((x) => x.name)])).toEqual([
      ["Project", ["p"]],
      ["Local", ["l"]],
      ["User", ["a", "b"]],
      ["claude.ai", ["c"]],
      ["dynamic", ["z"]],
      ["other", ["n"]],
    ]);
    expect(groupServers(servers, "A").map(([g, l]) => [g, l.map((x) => x.name)])).toEqual([["user", ["a"]]]);
    expect(groupServers(servers, "nothing")).toEqual([]);
  });

  it("labels each status with the extension's icon and text", () => {
    expect(["connected", "failed", "needs-auth", "pending", "disabled", "odd"].map((x) => `${statusIcon(x)} ${statusLabel(x)}`)).toEqual(["✓ Connected", "✗ Failed", "⚠ Needs Auth", "◐ Connecting…", "○ Disabled", "? odd"]);
  });

  it("offers the actions the status allows", () => {
    expect(actionsFor(s("x", "connected", "user", "http"))).toEqual(["reconnect", "clearAuth", "disable"]);
    expect(actionsFor(s("x", "connected", "user", "stdio"))).toEqual(["reconnect", "disable"]);
    expect(actionsFor(s("x", "connected", "claudeai", "claudeai-proxy"))).toEqual(["reconnect", "disable"]);
    expect(actionsFor(s("x", "needs-auth", "user", "sse"))).toEqual(["authenticate", "disable"]);
    expect(actionsFor(s("x", "needs-auth", "claudeai", "claudeai-proxy"))).toEqual(["authenticate", "disable"]);
    expect(actionsFor(s("x", "failed", "user", "http"))).toEqual(["authenticate", "reconnect", "disable"]);
    expect(actionsFor(s("x", "failed", "project", "stdio"))).toEqual(["reconnect", "disable"]);
    expect(actionsFor(s("x", "failed", "user", "http"), true)).toEqual([]);
    expect(actionsFor(s("x", "disabled", "user"))).toEqual(["enable"]);
    expect(actionsFor(s("x", "pending", "user"))).toEqual([]);
  });

  it("offers Remove only for local, user and project servers that no plugin owns", () => {
    expect(["local", "user", "project", "claudeai", "managed", "enterprise", "dynamic", undefined].map((scope) => canRemove(s("x", "connected", scope)))).toEqual([true, true, true, false, false, false, false, false]);
    expect(canRemove(s("x", "connected", "user", "stdio", { source: "plugin" }))).toBe(false);
  });

  it("shows the first line of a server error without tags, cut at 200 characters", () => {
    expect(errorLine("<b>Connection</b> closed\nstack")).toBe("Connection closed");
    expect(errorLine("x".repeat(250))).toBe(`${"x".repeat(200)}…`);
  });

  it("validates the add form with the extension's texts and line numbers", () => {
    const f: AddForm = { name: "tools", transport: "stdio", command: " npx ", args: "-y\n\n pkg ", env: " A = 1 \n\nB=x=y", url: "", headers: "" };
    expect(buildAdd(f)).toEqual({ name: "tools", config: { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: ["A=1", "B=x=y"] } });
    expect(buildAdd({ ...f, name: " " })).toEqual({ error: "Server name is required." });
    expect(buildAdd({ ...f, name: "a b" })).toEqual({ error: "Invalid name a b. Names can only contain letters, numbers, hyphens, and underscores." });
    expect(buildAdd({ ...f, command: "" })).toEqual({ error: "Command is required." });
    expect(buildAdd({ ...f, env: "A=1\n\nnovalue" })).toEqual({ error: "Environment variables must be KEY=value (line 3)." });
    const h: AddForm = { ...f, transport: "http", url: " https://x/mcp ", headers: "Authorization: Bearer t\n" };
    expect(buildAdd(h)).toEqual({ name: "tools", config: { transport: "http", url: "https://x/mcp", headers: ["Authorization: Bearer t"] } });
    expect(buildAdd({ ...h, transport: "sse", url: "" })).toEqual({ error: "URL is required." });
    expect(buildAdd({ ...h, headers: "ok: 1\n: no" })).toEqual({ error: 'Headers must be "Header-Name: value" (line 2).' });
  });

  it("orders palette rows needs-auth first", () => {
    expect(paletteOrder([s("a", "connected"), s("z", "needs-auth"), s("b", "failed")]).map((x) => x.name)).toEqual(["z", "a", "b"]);
  });
});
