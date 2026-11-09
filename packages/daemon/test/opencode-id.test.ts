import { describe, expect, it } from "vitest";
import { ascending } from "../src/opencode-id.ts";

describe("ascending", () => {
  it("makes 30 character ids with the prefix that sort in creation order", () => {
    const ids = Array.from({ length: 50 }, () => ascending("msg"));
    expect(ids.every((id) => /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(id) && id.length === 30)).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(ascending("prt").startsWith("prt_")).toBe(true);
  });
});
