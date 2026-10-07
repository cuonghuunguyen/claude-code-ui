import { expect, it } from "vitest";
import { fromMnt, fromWslUnc, localIsWindows, sideLookup } from "./sides.tsx";

it("reads a WSL path written the Windows way as its distro's POSIX path", () => {
  expect(fromWslUnc("\\\\wsl.localhost\\Ubuntu\\home\\me")).toEqual({ side: "wsl:Ubuntu", path: "/home/me" });
  expect(fromWslUnc("\\\\wsl$\\Debian")).toEqual({ side: "wsl:Debian", path: "/" });
  expect(fromWslUnc("C:\\Users")).toBeUndefined();
});

it("maps a /mnt drive folder to its Windows path", () => {
  expect(fromMnt("/mnt/c/Users/me/proj")).toBe("C:\\Users\\me\\proj");
  expect(fromMnt("/mnt/d")).toBe("D:\\");
  expect(fromMnt("/mnt/data/x")).toBeUndefined();
  expect(fromMnt("/home/me")).toBeUndefined();
});

it("labels cwds only when there is more than one side", () => {
  const sides = [{ id: "local", label: "Windows", state: "ready" as const }, { id: "wsl:Ubuntu", label: "WSL: Ubuntu", state: "ready" as const }];
  const l = sideLookup(sides, { "/home/me/p": "wsl:Ubuntu" });
  expect([l.label("/home/me/p"), l.label("C:\\p")]).toEqual(["WSL: Ubuntu", "Windows"]);
  expect([l.badge("/home/me/p")?.short, l.badge("C:\\p")?.short]).toEqual(["WSL", "Win"]);
  const two = sideLookup([...sides, { id: "wsl:Debian", label: "WSL: Debian", state: "off" }], { "/home/me/p": "wsl:Ubuntu" });
  expect(two.badge("/home/me/p")).toEqual({ label: "WSL: Ubuntu", short: "Ubuntu" });
  expect(sideLookup(undefined).label("C:\\p")).toBeUndefined();
  expect(sideLookup([sides[0]!]).label("C:\\p")).toBeUndefined();
});

it("short badges: Docker or the container name, WSL counted on its own, local by its label", () => {
  const local = { id: "local", label: "Windows", state: "ready" as const };
  const wsl = { id: "wsl:Ubuntu", label: "WSL: Ubuntu", state: "ready" as const };
  const dev = { id: "docker:dev", label: "Docker: dev", state: "ready" as const };
  const cwds = { "/a": "wsl:Ubuntu", "/b": "docker:dev", "/c": "docker:api" };
  const one = sideLookup([local, wsl, dev], cwds);
  expect([one.badge("C:\\p")?.short, one.badge("/a")?.short, one.badge("/b")?.short]).toEqual(["Win", "WSL", "Docker"]);
  const two = sideLookup([local, wsl, dev, { id: "docker:api", label: "Docker: api", state: "off" as const }], cwds);
  expect([two.badge("/b")?.short, two.badge("/c")?.short, two.badge("/a")?.short]).toEqual(["dev", "api", "WSL"]);
  const linux = [{ id: "local", label: "Linux", state: "ready" as const }, dev];
  expect(sideLookup(linux, cwds).badge("/home/me")?.short).toBe("Linux");
  expect([localIsWindows([local, wsl]), localIsWindows(linux)]).toEqual([true, false]);
});
