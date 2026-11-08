import { describe, expect, it } from "vitest";
import type { OpenCodeProvider } from "@claude-ui/protocol";
import { checkLogin, loginError, mergeProviders } from "../src/opencode-providers.ts";
import { OpenCodeHttpError } from "../src/opencode-server.ts";

describe("mergeProviders", () => {
  it("connected first, popular next, then by name; opencode without a priced model is not connected; default method is an API key", () => {
    const all = [{ id: "zed", name: "Zed" }, { id: "openai", name: "OpenAI" }, { id: "abc", name: "Abc" }, { id: "opencode", name: "OpenCode", models: { a: { cost: { input: 0 } } } }, { id: "mine", name: "Mine", source: "api" as const }];
    const r = mergeProviders({ all, connected: ["zed", "opencode", "mine"] }, { openai: [{ type: "oauth", label: "Browser" }] });
    expect(r.map((p) => p.id)).toEqual(["mine", "zed", "opencode", "openai", "abc"]);
    expect(r.find((p) => p.id === "opencode")!.connected).toBe(false);
    expect(r.find((p) => p.id === "abc")!.methods).toEqual([{ type: "api", label: "API key" }]);
    expect(r.find((p) => p.id === "openai")!.methods[0]!.label).toBe("Browser");
  });
  it("opencode with a priced model is connected", () => {
    expect(mergeProviders({ all: [{ id: "opencode", name: "OpenCode", models: { a: { cost: { input: 2 } } } }], connected: ["opencode"] }, {})[0]!.connected).toBe(true);
  });
});

describe("checkLogin", () => {
  const providers: OpenCodeProvider[] = [{ id: "p", name: "P", connected: false, methods: [{ type: "api", label: "API key" }, { type: "oauth", label: "Browser" }] }];
  it("accepts a key and refuses the rest", () => {
    expect(checkLogin({ provider: "p", method: 0, key: "k1" }, providers, "api")).toMatchObject({ key: "k1" });
    expect(checkLogin({ provider: "p", method: 1 }, providers, "oauth")).toMatchObject({ method: { type: "oauth" } });
    for (const bad of [{ provider: "q", method: 0, key: "k" }, { provider: "p", method: 1, key: "k" }, { provider: "p", method: 0, key: " " }, { provider: "p", method: 0, key: "a b" }, { provider: "p", method: 0 }, { provider: "p", method: "0", key: "k" }])
      expect(checkLogin(bad, providers, "api")).toHaveProperty("error");
  });
});

describe("loginError", () => {
  const err = (name: string, data: object = {}) => new OpenCodeHttpError("x", 400, { name, data });
  it("maps OpenCode names", () => {
    expect(loginError(err("ProviderAuthValidationFailed", { field: "team", message: "bad" }))).toBe("team: bad");
    expect(loginError(err("ProviderAuthOauthCallbackFailed"))).toBe("Login was not completed. Try again.");
    expect(loginError(err("ProviderAuthOauthCodeMissing"))).toBe("code: Enter the code");
    expect(loginError(err("ProviderAuthOauthMissing"))).toBe("The login expired. Start it again.");
    expect(loginError(new OpenCodeHttpError("x", 500, { name: "UnknownError", data: { message: "boom" } }))).toBe("OpenCode answered 500: boom");
    expect(loginError(new Error("plain"))).toBe("plain");
  });
});
