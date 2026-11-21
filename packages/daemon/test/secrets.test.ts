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
  expect(old.jiraOrigins()).toEqual([]);
  expect(old.jiraTokenReset()).toBe(true);
  // The token is gone from the disk, the flag is persisted (GH-487).
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jiraTokenReset: true });
  expect(createSecrets({ file }).jiraTokenReset()).toBe(true);
  old.endJiraTokenReset();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  const s = createSecrets({ file });
  s.setJiraToken("tok", A);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jiraToken: "tok", jiraOrigin: A, jiraTokens: { [A]: "tok" } });
  expect(s.jiraToken("https://b.example.com")).toBeUndefined();
  expect(s.jiraToken(A)).toBe("tok");
  expect(s.jiraTokenReset()).toBe(false);
  s.setJiraToken(null, A);
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
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ jiraToken: "tok", jiraOrigin: "https://a.example.com", jiraTokens: { "https://a.example.com": "tok" } });
  s.bindJiraToken("https://b.example.com");
  expect(s.jiraOrigins()).toEqual(["https://a.example.com"]);
  expect(s.jiraToken("https://a.example.com")).toBe("tok");
});

it("bindJiraToken: the token typed in Settings › Jira without URL replaces a Project's token of the first global URL's origin (GH-915)", () => {
  const X = "https://acme.atlassian.net";
  const s = createSecrets();
  s.setJiraToken("tok-project", X, "");
  s.setJiraToken("tok-global", "", "");
  s.bindJiraToken(X);
  expect(s.jiraOrigins()).toEqual([X]);
  expect(s.jiraToken(X)).toBe("tok-global");
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
  s.setJiraToken(null, "https://example.com");
  expect(s.claudeToken(id)).toBe("tok-a");
});

const A = "https://acme.atlassian.net";
const B = "https://jira.example.com";
const tmpFile = () => join(mkdtempSync(join(tmpdir(), "secrets-")), "secrets.json");

it("one token per Jira origin: Projects of the same origin share it, another origin has its own; survives a restart (GH-894)", () => {
  const file = tmpFile();
  const s = createSecrets({ file });
  s.setJiraToken("tok-a", A);
  s.setJiraToken("tok-b", B, A);
  expect(s.jiraToken(A)).toBe("tok-a");
  expect(s.jiraToken(B)).toBe("tok-b");
  expect(s.jiraToken("https://other.example.com")).toBeUndefined();
  expect(s.jiraOrigins().sort()).toEqual([B, A].sort());
  const again = createSecrets({ file });
  expect(again.jiraToken(A)).toBe("tok-a");
  expect(again.jiraToken(B)).toBe("tok-b");
  s.setJiraToken(null, B, A);
  expect(createSecrets({ file }).jiraOrigins()).toEqual([A]);
  expect(createSecrets({ file }).jiraToken("__proto__")).toBeUndefined();
});

it("an old-format file { jiraToken, jiraOrigin } migrates to the origin map (GH-894)", () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ jiraToken: "tok-old", jiraOrigin: A }));
  const s = createSecrets({ file });
  expect(s.jiraToken(A)).toBe("tok-old");
  expect(s.jiraOrigins()).toEqual([A]);
  s.setJiraToken("tok-b", B, A);
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ jiraTokens: { [A]: "tok-old", [B]: "tok-b" } });
});

it("the token of the global origin is also written as jiraToken + jiraOrigin so an older daemon finds it; a Project token never replaces it (GH-894)", () => {
  const file = tmpFile();
  const s = createSecrets({ file });
  const disk = () => JSON.parse(readFileSync(file, "utf8"));
  s.setJiraToken("tok-a", A, A);
  expect(disk()).toMatchObject({ jiraToken: "tok-a", jiraOrigin: A });
  s.setJiraToken("tok-b", B, A);
  expect(disk()).toMatchObject({ jiraToken: "tok-a", jiraOrigin: A, jiraTokens: { [A]: "tok-a", [B]: "tok-b" } });
  // The global URL moves to the other origin: the mirror follows; without a token there the mirror is gone.
  s.pruneJiraTokens([A, B], B);
  expect(disk()).toMatchObject({ jiraToken: "tok-b", jiraOrigin: B });
  s.pruneJiraTokens([A, B], "https://none.example.com");
  expect(disk().jiraToken).toBeUndefined();
  expect(disk().jiraOrigin).toBeUndefined();
  expect(disk().jiraTokens).toEqual({ [A]: "tok-a", [B]: "tok-b" });
});

it("pruneJiraTokens drops the tokens of origins nothing uses and writes nothing when nothing changes (GH-894)", () => {
  const file = tmpFile();
  const s = createSecrets({ file });
  s.setJiraToken("tok-a", A, A);
  s.setJiraToken("tok-b", B, A);
  const before = readFileSync(file, "utf8");
  s.pruneJiraTokens([A, B], A);
  expect(readFileSync(file, "utf8")).toBe(before);
  s.pruneJiraTokens([A], A);
  expect(s.jiraOrigins()).toEqual([A]);
  expect(s.jiraToken(B)).toBeUndefined();
  s.pruneJiraTokens([], "");
  expect(s.jiraOrigins()).toEqual([]);
  expect(JSON.parse(readFileSync(file, "utf8")).jiraToken).toBeUndefined();
});

it("values() returns every Jira token so terminal output redacts them all (GH-894)", () => {
  const s = createSecrets({ file: tmpFile() });
  s.setJiraToken("tok-a", A, A);
  s.setJiraToken("tok-b", B, A);
  expect(s.values().sort()).toEqual(["tok-a", "tok-b"]);
});
