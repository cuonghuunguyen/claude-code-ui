import { describe, expect, it } from "vitest";
import { clearToken, parsePairing, storeToken, takeToken } from "./pairing.ts";

const storage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("takeToken", () => {
  it("takes the token from the pairing URL fragment, stores it, and strips it from the address bar", () => {
    const s = storage();
    const replaced: string[] = [];
    const loc = { hash: "#token=abc_-1", pathname: "/", search: "" };
    expect(takeToken(loc, s, (url) => replaced.push(url))).toBe("abc_-1");
    expect(replaced).toEqual(["/"]);
    expect(takeToken({ hash: "", pathname: "/", search: "" }, s, () => {})).toBe("abc_-1");
  });

  it("returns undefined for a browser that was never paired", () => {
    expect(takeToken({ hash: "", pathname: "/", search: "" }, storage(), () => {})).toBeUndefined();
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
  it("write and remove the token takeToken reads", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    storeToken(TOKEN, s);
    expect(takeToken({ hash: "", pathname: "/", search: "" }, s, () => {})).toBe(TOKEN);
    clearToken(s);
    expect(takeToken({ hash: "", pathname: "/", search: "" }, s, () => {})).toBeUndefined();
  });
});
