import { describe, expect, it } from "vitest";
import { plainText, redactSecrets } from "../src/terminal-text.ts";

describe("plainText", () => {
  it("drops colour, cursor and OSC sequences", () => {
    expect(plainText("\x1b[31mred\x1b[0m ok\x1b]0;title\x07!\x1b]8;;http://x\x1b\\link\x1b[2K")).toBe("red ok!link");
  });
  it("joins CRLF as LF and keeps the text after the last bare CR of a line (progress bars)", () => {
    expect(plainText("a\r\nb\r\n")).toBe("a\nb\n");
    expect(plainText("10%\r50%\r100%\ndone")).toBe("100%\ndone");
  });
  it("applies backspace to one char and drops other control chars but tab", () => {
    expect(plainText("abc\b\bX\x07\x00\tz")).toBe("aX\tz");
  });
  it("drops two-char escape sequences", () => {
    expect(plainText("\x1b=a\x1b>b")).toBe("ab");
  });
});

describe("redactSecrets", () => {
  const r = (t: string, known: string[] = []) => redactSecrets(t, known);
  it("replaces known exact values of 8+ chars, not shorter ones", () => {
    expect(r("x supersecretvalue y", ["supersecretvalue"])).toEqual({ text: "x [redacted] y", count: 1 });
    expect(r("x abc y", ["abc"])).toEqual({ text: "x abc y", count: 0 });
  });
  it.each([
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIB\nabc\n-----END RSA PRIVATE KEY-----"],
    ["anthropic", "sk-ant-api03-abcdefghijklmnopqrstu"],
    ["openai", "sk-abcdefghijklmnopqrstuvwx"],
    ["github", "ghp_" + "a".repeat(36)],
    ["github pat", "github_pat_" + "a".repeat(40)],
    ["gitlab", "glpat-abcdefghijklmnopqrst"],
    ["slack", "xoxb-1234567890-abc"],
    ["aws", "AKIAABCDEFGHIJKLMNOP"],
    ["google", "AIza" + "a".repeat(35)],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkw.abcdefghijklmnop"],
  ])("redacts a %s", (_n, secret) => {
    const out = r(`before ${secret} after`);
    expect(out.text).not.toContain(secret.slice(0, 20));
    expect(out.text).toContain("[redacted]");
    expect(out.count).toBeGreaterThan(0);
  });
  it("redacts the value of an Authorization header and a Bearer token only", () => {
    expect(r("Authorization: Bearer abc.def-123").text).toBe("Authorization: Bearer [redacted]");
    expect(r("curl -H 'Authorization: Basic dXNlcjpwYXNz'").text).toContain("Basic [redacted]");
    expect(r("got Bearer tok_12345678 ok").text).toBe("got Bearer [redacted] ok");
  });
  it("redacts URL credentials", () => {
    expect(r("git clone https://user:pw@example.com/x").text).toBe("git clone https://example.com/x");
    expect(r("git clone https://user:pw@example.com/x").count).toBe(1);
  });
  it("redacts the value of env-style assignments", () => {
    expect(r("export DEMO_TOKEN=abcd1234efgh5678\nMY_PASSWORD: hunter2\napi_key = xyz").text).toBe("export DEMO_TOKEN=[redacted]\nMY_PASSWORD: [redacted]\napi_key = [redacted]");
  });
  it("does not touch a plain hash, a git SHA or ordinary text", () => {
    const sha = "a".repeat(20) + "0123456789".repeat(2);
    expect(r(`commit ${sha}\nhello world`)).toEqual({ text: `commit ${sha}\nhello world`, count: 0 });
  });
});
