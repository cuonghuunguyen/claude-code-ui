import { describe, expect, it, vi } from "vitest";
import { loadDraft, saveDraft } from "./drafts.ts";
import { adoptToken, clearToken, parsePairing, storedToken, storeToken } from "./pairing.ts";

const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

const STORED = "S".repeat(43);
const OTHER = "O".repeat(43);
const empty = { hash: "", pathname: "/", search: "" };
const link = (token: string) => ({ hash: `#token=${token}`, pathname: "/p", search: "?q=1" });

describe("adoptToken (GH-282)", () => {
  const run = async (loc: typeof empty, stored: string | undefined, accepted: (t: string) => Promise<boolean>) => {
    const s = storage();
    if (stored) s.setItem("claude-ui.token", stored);
    const replaced: string[] = [];
    const asked: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await adoptToken(loc, s, (u) => replaced.push(u), (t) => (asked.push(t), accepted(t)));
    warn.mockRestore();
    return { result, replaced, asked, stored: s.getItem("claude-ui.token") };
  };

  it("no fragment: nothing happens", async () => {
    const r = await run(empty, STORED, async () => true);
    expect(r).toMatchObject({ result: "none", replaced: [], asked: [], stored: STORED });
  });
  it("unpaired + valid-shape fragment: stored, fragment stripped, no check", async () => {
    const r = await run(link(OTHER), undefined, async () => false);
    expect(r).toMatchObject({ result: "stored", replaced: ["/p?q=1"], asked: [], stored: OTHER });
  });
  it("paired + same token: kept, no check", async () => {
    const r = await run(link(STORED), STORED, async () => false);
    expect(r).toMatchObject({ result: "kept", replaced: ["/p?q=1"], asked: [], stored: STORED });
  });
  it("paired + other token the daemon rejects: kept, stored value unchanged, fragment stripped", async () => {
    const r = await run(link(OTHER), STORED, async () => false);
    expect(r).toMatchObject({ result: "kept", replaced: ["/p?q=1"], asked: [OTHER], stored: STORED });
  });
  it("paired + other token, daemon unreachable: kept", async () => {
    const r = await run(link(OTHER), STORED, () => Promise.reject(new Error("down")));
    expect(r).toMatchObject({ result: "kept", stored: STORED });
  });
  it("paired + other token the daemon accepts: stored", async () => {
    const r = await run(link(OTHER), STORED, async () => true);
    expect(r).toMatchObject({ result: "stored", asked: [OTHER], stored: OTHER });
  });
  it("junk fragment: kept, nothing stored, fragment stripped", async () => {
    const r = await run(link("abc"), undefined, async () => true);
    expect(r).toMatchObject({ result: "kept", replaced: ["/p?q=1"], asked: [], stored: null });
  });
});

describe("storedToken", () => {
  it("reads what storeToken wrote, undefined for a browser never paired", () => {
    const s = storage();
    expect(storedToken(s)).toBeUndefined();
    storeToken(TOKEN, s);
    expect(storedToken(s)).toBe(TOKEN);
  });
});

const TOKEN = "aB3_-xYz0123456789abcdefghijklmnopqrstuv"; // 40 chars of base64url

describe("parsePairing", () => {
  it("accepts a full pairing URL of any origin, a bare #token= fragment and a bare token", () => {
    expect(parsePairing(`https://box.tail1234.ts.net/#token=${TOKEN}`)).toBe(TOKEN);
    expect(parsePairing(`http://192.168.1.20:4280/#token=${TOKEN}`)).toBe(TOKEN);
    expect(parsePairing(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(parsePairing(`token=${TOKEN}`)).toBe(TOKEN);
    expect(parsePairing(TOKEN)).toBe(TOKEN);
  });

  it("trims whitespace and ignores other hash parameters", () => {
    expect(parsePairing(["  ", TOKEN, " "].join(String.fromCharCode(10)))).toBe(TOKEN);
    expect(parsePairing(String.fromCharCode(9) + TOKEN + " ")).toBe(TOKEN);
    expect(parsePairing(`http://x/#foo=1&token=${TOKEN}&bar=2`)).toBe(TOKEN);
  });

  it("rejects junk, an empty string, a short token and a URL without a token", () => {
    for (const bad of ["", "   ", "hello world", "abc", "token=short", "https://x.ts.net/", `https://x.ts.net/?token=${TOKEN}`, `${TOKEN} ${TOKEN}`, "<script>alert(1)</script>"]) {
      expect(parsePairing(bad), bad).toBeUndefined();
    }
  });
});

describe("storeToken and clearToken", () => {
  it("write and remove the token storedToken reads", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    storeToken(TOKEN, s);
    expect(storedToken(s)).toBe(TOKEN);
    saveDraft("s1", "unsent", s);
    clearToken(s);
    expect(loadDraft("s1", s)).toBe("");
    expect(storedToken(s)).toBeUndefined();
  });
});
