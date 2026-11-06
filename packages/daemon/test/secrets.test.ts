import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createSecrets } from "../src/secrets.ts";

it("a corrupt secrets.json logs no file content (GH-451)", () => {
  for (const content of ["tok-SECRET-1", '{"jiraToken":"tok-SECRET-1"']) {
    const file = join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json");
    writeFileSync(file, content);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(createSecrets({ file }).jiraToken("")).toBeUndefined();
      expect(log).toHaveBeenCalledTimes(1);
      const text = log.mock.calls.flat().map(String).join(" ");
      expect(text).toContain("secrets");
      expect(text).toContain("not valid JSON");
      expect(text).not.toContain("tok-SECRET-1");
    } finally {
      log.mockRestore();
    }
  }
});

it("the token is returned only for the origin it was saved for; an old-format token counts as not set and is flagged (GH-487)", () => {
  const A = "https://a.example.com";
  const file = join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json");
  writeFileSync(file, '{"jiraToken":"tok"}');
  const old = createSecrets({ file });
  expect(old.jiraToken("https://jira.example.com")).toBeUndefined();
  expect(old.jiraToken("")).toBeUndefined();
  expect(old.jiraTokenOrigin()).toBeUndefined();
  expect(old.jiraTokenReset()).toBe(true);
  // The token is gone from the disk, the flag is persisted (GH-487).
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jiraTokenReset: true });
  expect(createSecrets({ file }).jiraTokenReset()).toBe(true);
  old.endJiraTokenReset();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  const s = createSecrets({ file });
  s.setJiraToken("tok", A);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jiraToken: "tok", jiraOrigin: A });
  expect(s.jiraToken("https://b.example.com")).toBeUndefined();
  expect(s.jiraToken(A)).toBe("tok");
  expect(s.jiraTokenReset()).toBe(false);
  s.setJiraToken(null);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  expect(createSecrets({ file }).jiraTokenReset()).toBe(false);
});

it("bindJiraToken binds a token saved without URL in one write and never rebinds one with an origin (GH-487)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json");
  const s = createSecrets({ file });
  s.bindJiraToken("https://a.example.com"); // no token: nothing written
  expect(existsSync(file)).toBe(false);
  s.setJiraToken("tok");
  s.bindJiraToken("https://a.example.com");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jiraToken: "tok", jiraOrigin: "https://a.example.com" });
  s.bindJiraToken("https://b.example.com");
  expect(s.jiraTokenOrigin()).toBe("https://a.example.com");
  expect(s.jiraToken("https://a.example.com")).toBe("tok");
});

it("Claude token accounts: add, list without tokens, remove; invalid name or token refused; the file is 0600 (GH-615)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json");
  const s = createSecrets({ file });
  const id = s.addClaudeAccount("Work", "sk-ant-oat01-TESTSECRET");
  expect(s.claudeAccounts()).toEqual([{ id, name: "Work" }]);
  expect(JSON.stringify(s.claudeAccounts())).not.toContain("TESTSECRET");
  expect(s.claudeToken(id)).toBe("sk-ant-oat01-TESTSECRET");
  expect(createSecrets({ file }).claudeToken(id)).toBe("sk-ant-oat01-TESTSECRET");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(() => s.addClaudeAccount("", "tok")).toThrow(/name/);
  expect(() => s.addClaudeAccount("A\nB", "tok")).toThrow(/name/);
  expect(() => s.addClaudeAccount("x", "has space")).toThrow(/token/);
  s.removeClaudeAccount(id);
  expect(s.claudeAccounts()).toEqual([]);
  expect(s.claudeToken(id)).toBeUndefined();
});

it("Claude accounts and the Jira token live side by side in the file", () => {
  const s = createSecrets({ file: join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json") });
  const id = s.addClaudeAccount("A", "tok-a");
  s.setJiraToken("jira-tok", "https://example.com");
  expect(s.jiraToken("https://example.com")).toBe("jira-tok");
  expect(s.claudeToken(id)).toBe("tok-a");
  s.setJiraToken(null);
  expect(s.claudeToken(id)).toBe("tok-a");
});
