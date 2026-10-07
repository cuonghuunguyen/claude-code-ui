import { expect, it } from "vitest";
import { gitRows } from "./git-changes.ts";

it("gitRows makes absolute paths under the repository root, kinds from status, stats only when known", () => {
  const rows = gitRows(
    {
      prefix: "s/",
      base: "b",
      files: [
        { status: "M", path: "a.ts", added: 1, removed: 2 },
        { status: "R", path: "n.ts", oldPath: "o.ts", added: 0, removed: 0 },
        { status: "A", path: "img.png" },
        { status: "A", path: "s/u.ts", untracked: true, added: 3, removed: 0 },
        { status: "D", path: "gone.ts", added: 0, removed: 4 },
      ],
    },
    "/r/s",
  );
  expect(rows).toEqual([
    { path: "/r/a.ts", rel: "a.ts", kind: "M", stats: { added: 1, removed: 2 } },
    { path: "/r/n.ts", rel: "n.ts", oldPath: "o.ts", kind: "R", stats: { added: 0, removed: 0 } },
    { path: "/r/img.png", rel: "img.png", kind: "A" },
    { path: "/r/s/u.ts", rel: "s/u.ts", kind: "A", stats: { added: 3, removed: 0 }, untracked: true },
    { path: "/r/gone.ts", rel: "gone.ts", kind: "D", stats: { added: 0, removed: 4 } },
  ]);
  expect(gitRows({ prefix: "", files: [{ status: "M", path: "x/y.ts" }] }, "C:\\p")[0]!.path).toBe("C:\\p\\x\\y.ts");
});
