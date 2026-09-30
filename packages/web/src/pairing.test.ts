import { describe, expect, it } from "vitest";
import { takeToken } from "./pairing.ts";

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
