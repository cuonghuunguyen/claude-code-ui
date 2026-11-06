import { afterEach, expect, it } from "vitest";
import { claudeEnv, setClaudeToken } from "../src/claude-env.ts";

const env = { PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "inherited" };
afterEach(() => setClaudeToken(undefined));

it("Default keeps the inherited token; the CLI login removes it; a token account sets it; API keys never pass", () => {
  expect(claudeEnv(env)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "inherited" });
  setClaudeToken(null);
  expect(claudeEnv(env)).toEqual({ PATH: "/bin" });
  setClaudeToken("picked");
  expect(claudeEnv(env)).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "picked" });
});

it("an explicit token overrides the active one", () => {
  setClaudeToken(null);
  expect(claudeEnv(env, "x")).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "x" });
});
