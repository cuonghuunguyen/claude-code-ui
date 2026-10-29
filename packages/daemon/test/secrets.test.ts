import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
      expect(createSecrets({ file }).jiraToken()).toBeUndefined();
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
  expect(old.jiraTokenOrigin()).toBeUndefined();
  expect(old.jiraTokenReset()).toBe(true);
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
