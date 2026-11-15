import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROUTES, routeOf } from "./side-routes.ts";

/** The `type` literals of the `ClientMessage` union in wire.ts (comments stripped; one member may name several types). */
function clientTypes(): string[] {
  const src = readFileSync(new URL("../../protocol/src/wire.ts", import.meta.url), "utf8");
  const start = src.indexOf("export type ClientMessage =");
  const body = src.slice(start, src.indexOf("\n);", start)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...body.matchAll(/\{\s*type:\s*((?:"[^"]+"\s*\|?\s*)+)[;}]/g)].flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!));
}

describe("Hub routing table", () => {
  it("every ClientMessage type has a routing class", () => {
    expect(clientTypes().sort()).toEqual(Object.keys(ROUTES).sort());
  });
  it("an unknown or malformed type is routed by `side` only", () => {
    for (const t of ["nope", undefined, 7, "__proto__", "constructor", "toString"]) expect(routeOf(t)).toEqual({ by: "named" });
  });
});
