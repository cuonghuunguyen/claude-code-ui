import { describe, expect, it } from "vitest";
import { isPaneRef, kindOf, ownerOf, paneTabTitle, parseRef, refOf, splittable } from "./pane-ref.ts";

const U = "0f8e7d6c-1234-4abc-8def-0123456789ab";

describe("pane refs", () => {
  it("parseRef reads plan:<uuid> and rejects sessions, new, focus, other kinds and bad uuids", () => {
    expect(parseRef(`plan:${U}`)).toEqual({ kind: "plan", owner: U });
    for (const id of [U.toUpperCase().replace("PLAN", "plan"), `plan:${U.toUpperCase()}`, U, "new", "focus", `files:${U}`, "plan:abc", `plan:${U}x`, "", undefined]) expect(parseRef(id)).toBeUndefined();
    expect(isPaneRef(`plan:${U}`)).toBe(true);
    expect(isPaneRef(U)).toBe(false);
    expect(isPaneRef(undefined)).toBe(false);
  });
  it("refOf round-trips parseRef", () => {
    expect(refOf(parseRef(`plan:${U}`)!)).toBe(`plan:${U}`);
  });
  it("ownerOf returns the owner of a ref and the id itself otherwise", () => {
    expect(ownerOf(`plan:${U}`)).toBe(U);
    expect(ownerOf(U)).toBe(U);
    expect(ownerOf("new")).toBe("new");
    expect(kindOf(`plan:${U}`)).toBe("plan");
    expect(kindOf(U)).toBeUndefined();
  });
  it("splittable is false for plan refs", () => {
    expect(splittable(`plan:${U}`)).toBe(false);
  });
  it("paneTabTitle is \"Plan · <title>\"", () => {
    expect(paneTabTitle("plan", "Fix bug")).toBe("Plan · Fix bug");
  });
});
