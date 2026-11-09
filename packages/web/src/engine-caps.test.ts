import { describe, expect, it } from "vitest";
import { ALL_CAPABILITIES, PERMISSION_MODES, type ModelInfo } from "@claude-ui/protocol";
import { effortOptions, modesOf } from "./toolbar.tsx";

const models: ModelInfo[] = [
  { value: "m", displayName: "M", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"], supportsAutoMode: true },
  { value: "n", displayName: "N", description: "" },
];

describe("modesOf", () => {
  it("without flags follows the model's auto support and the offered bypass", () => {
    expect(modesOf(["default"], "m", [])).toEqual(["default"]);
    expect(modesOf(["default", "bypassPermissions"], "m", models)).toEqual(PERMISSION_MODES);
    expect(modesOf(["default"], "n", models)).toEqual(PERMISSION_MODES.filter((x) => x !== "auto" && x !== "bypassPermissions"));
  });
  it("lists only the modes of the session's Engine", () => {
    const permissionModes = ["default" as const, "plan" as const, "acceptEdits" as const, "bypassPermissions" as const];
    const got = modesOf(["default", "bypassPermissions"], "m", models, { ...ALL_CAPABILITIES, permissionModes });
    expect(got).toEqual(permissionModes);
    expect(got).not.toContain("auto");
    expect(got).not.toContain("dontAsk");
  });
});

describe("effortOptions", () => {
  it("lists the model's levels, none when the Engine has no effort", () => {
    expect(effortOptions(models, "m")).toEqual(["default", "low", "high"]);
    expect(effortOptions(models, "m", { ...ALL_CAPABILITIES, effort: false })).toEqual([]);
  });
});
