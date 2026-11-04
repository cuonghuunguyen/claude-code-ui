import { afterEach, expect, it } from "vitest";
import { iconSrc, projectLabel, setLabels, sideLabel, withLabel } from "./labels.ts";
import { projectName } from "./tabs.ts";

afterEach(() => setLabels(undefined));

it("withLabel adds, replaces, trims and removes", () => {
  const a = withLabel({}, "/p", { name: "  App  ", icon: "🚀" });
  expect(a).toEqual({ "/p": { name: "App", icon: "🚀" } });
  expect(withLabel(a, "/p", { name: "B" })).toEqual({ "/p": { name: "B" } });
  expect(withLabel(a, "/p", undefined)).toEqual({});
  expect(withLabel(a, "/p", { name: "  " })).toEqual({});
  expect(a).toEqual({ "/p": { name: "App", icon: "🚀" } });
});

it("projectName is the folder name until a label names the project", () => {
  expect(projectName("/work/app")).toBe("app");
  setLabels({ projects: { "/work/app": { name: "Shop" } }, sides: { local: { icon: "💻" } } });
  expect(projectName("/work/app")).toBe("Shop");
  expect(projectName("/work/other")).toBe("other");
  expect(projectLabel("/work/app")?.name).toBe("Shop");
  expect(sideLabel("local")?.icon).toBe("💻");
});

it("an older daemon without labels gives no label", () => {
  setLabels(undefined);
  expect(projectLabel("/x")).toBeUndefined();
});

it("iconSrc gives only raster data URLs as image source", () => {
  expect(iconSrc("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  expect(iconSrc("data:image/svg+xml;base64,AAAA")).toBeUndefined();
  expect(iconSrc("javascript:alert(1)")).toBeUndefined();
  expect(iconSrc("🚀")).toBeUndefined();
  expect(iconSrc(undefined)).toBeUndefined();
});
