// Contract of the addon part list (packages/protocol/src/addon-parts.ts): external addon themes select `[data-part="..."]`;
// a part renamed or removed in the UI, or a name missing from the list, breaks them silently.
import { readdirSync, readFileSync } from "node:fs";
import { PARTS, PART_NAMES, type PartName } from "@claude-ui/protocol";
import { expect, it } from "vitest";

const dir = new URL(".", import.meta.url);
const sources = readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));

/** Every name a source writes as `data-part="x"` or `data-part={cond ? "x" : undefined}`. */
function used(): Set<string> {
  const names = new Set<string>();
  for (const f of sources) {
    const text = readFileSync(new URL(f, dir), "utf8");
    for (const m of text.matchAll(/data-part=(?:"([^"]+)"|\{([^}]*)\})/g)) {
      if (m[1]) names.add(m[1]);
      else for (const q of m[2]!.matchAll(/"([^"]+)"/g)) names.add(q[1]!);
    }
  }
  return names;
}

it("every data-part in the UI is a listed part", () => {
  const listed = new Set<string>(PARTS.map((x) => x.name));
  expect([...used()].filter((n) => !listed.has(n))).toEqual([]);
});

it("every listed part that is not deprecated or reserved is rendered", () => {
  const rendered = used();
  expect(PARTS.filter((x) => !x.deprecated && !x.reserved && !rendered.has(x.name)).map((x) => x.name)).toEqual([]);
});

it("part names are unique", () => {
  const names = PARTS.map((x) => x.name);
  expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
});

it("the built-in Neon CSS selects parts, not test hooks, for listed parts", () => {
  const css = readFileSync(new URL("index.css", dir), "utf8");
  const hooks = [...css.matchAll(/\[data-testid="([^"]+)"\]/g)].map((m) => m[1]!);
  const listed = new Set<string>(PARTS.map((x) => x.name));
  expect(hooks.filter((n) => listed.has(n))).toEqual([]);
});

it("PartName is the literal union of the listed names (not string)", () => {
  const ok: PartName = "titlebar";
  // @ts-expect-error a name that is not a part does not compile
  const bad: PartName = "not-a-part";
  expect([ok, bad].length).toBe(2);
  expect(PARTS.map((x) => x.name)).toEqual([...PART_NAMES]);
});
