import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadToken, pairingUrl } from "../src/token.ts";

describe("token", () => {
  it("is generated on first run, persisted owner-only, and reused on the next run", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cfg-")), "claude-ui");
    const first = loadToken(dir);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(join(dir, "token"), "utf8").trim()).toBe(first);
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
    expect(loadToken(dir)).toBe(first);
  });

  it("restores owner-only permissions on an existing token file", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "cfg-")), "claude-ui");
    const token = loadToken(dir);
    chmodSync(join(dir, "token"), 0o644);
    expect(loadToken(dir)).toBe(token);
    expect(statSync(join(dir, "token")).mode & 0o777).toBe(0o600);
  });

  it("puts the token in the URL fragment so it is never sent in an HTTP request", () => {
    expect(pairingUrl("http://127.0.0.1:4280", "abc")).toBe("http://127.0.0.1:4280/#token=abc");
  });
});
