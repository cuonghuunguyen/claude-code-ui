import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES, PERMISSION_MODES, capabilitiesOf, permissionModesFor } from "../src/index.ts";

describe("permissionModesFor", () => {
  it.each([
    [false, false, ["default", "acceptEdits", "plan", "dontAsk"]],
    [true, false, ["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]],
    [false, true, ["default", "acceptEdits", "plan", "auto", "dontAsk"]],
    [true, true, PERMISSION_MODES],
  ])("allowBypass %s, supportsAuto %s keeps the Claude list", (allowBypass, supportsAuto, want) => {
    expect(permissionModesFor({ allowBypass, supportsAuto })).toEqual(want);
  });

  it("filters the given modes only, in their order", () => {
    const modes = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;
    expect(permissionModesFor({ allowBypass: true, supportsAuto: true, modes: [...modes] })).toEqual(modes);
  });
});

describe("capabilitiesOf", () => {
  it("is everything when absent", () => expect(capabilitiesOf({})).toBe(ALL_CAPABILITIES));
  it("is the session's flags when present", () => {
    const x = { ...ALL_CAPABILITIES, effort: false };
    expect(capabilitiesOf({ capabilities: x })).toBe(x);
  });
});
