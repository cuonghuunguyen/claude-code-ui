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

it("gitEol turns the disk's CRLF into the repository's LF so unchanged lines do not differ; a CRLF repository keeps its CRLF", async () => {
  const { gitEol } = await import("./git-changes.ts");
  expect(gitEol("a\nb\n", "a\r\nb\r\nc\r\n")).toBe("a\nb\nc\n");
  expect(gitEol("", "x\r\n")).toBe("x\n");
  expect(gitEol("a\r\nb\r\n", "a\r\nb\r\nc\r\n")).toBe("a\r\nb\r\nc\r\n");
});

it("gitRows keeps the submodule marker and sets no stats", () => {
  const from = "c".repeat(40);
  expect(gitRows({ prefix: "", base: "b", files: [{ status: "M", path: "libs/lib", submodule: { from } }] }, "/p")).toEqual([{ path: "/p/libs/lib", rel: "libs/lib", kind: "M", submodule: { from } }]);
});

const inner = { path: "/r/tools/inner", rel: "tools/inner", kind: "nested" as const, parent: "/r", branch: "main" };

it("gitRows turns an untracked folder of a listed nested repository into a nested row without stats or untracked", () => {
  const d = { prefix: "", base: "b", files: [{ status: "A" as const, path: "tools/inner/", untracked: true }, { status: "A" as const, path: "n.ts", untracked: true, added: 1, removed: 0 }] };
  expect(gitRows(d, "/p", { top: "/r", repos: [inner] })).toEqual([
    { path: "/p/tools/inner", rel: "tools/inner", kind: "A", nested: inner },
    { path: "/p/n.ts", rel: "n.ts", kind: "A", stats: { added: 1, removed: 0 }, untracked: true },
  ]);
});

it("gitRows keeps an untracked folder that is not a listed nested repository, or whose parent is another repository", () => {
  const d = { prefix: "", base: "b", files: [{ status: "A" as const, path: "tools/inner/", untracked: true }] };
  expect(gitRows(d, "/p", { top: "/r", repos: [] })).toEqual([{ path: "/p/tools/inner/", rel: "tools/inner/", kind: "A", untracked: true }]);
  expect(gitRows(d, "/p", { top: "/r", repos: [{ ...inner, parent: "/other" }] })[0]!.nested).toBeUndefined();
  expect(gitRows(d, "/p")[0]!.nested).toBeUndefined();
});

it("gitRows matches a nested repository on Windows without case or separator differences", () => {
  const win = { path: "C:\\R\\tools\\inner", rel: "tools/inner", kind: "nested" as const, parent: "c:/r" };
  const d = { prefix: "", base: "b", files: [{ status: "A" as const, path: "Tools/Inner/", untracked: true }] };
  expect(gitRows(d, "C:\\p", { top: "C:\\r", repos: [win] })[0]!.nested).toBe(win);
});

it("eachLimited runs at most N at once and all items", async () => {
  const { eachLimited } = await import("./git-changes.ts");
  let running = 0;
  let peak = 0;
  const done: number[] = [];
  await eachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    done.push(x);
  });
  expect(peak).toBe(3);
  expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  await eachLimited([], 4, async () => {});
});

it("createLimiter runs at most N jobs at once across callers and skips queued jobs that are no longer live", async () => {
  const { createLimiter } = await import("./git-changes.ts");
  const limit = createLimiter(2);
  const rel: (() => void)[] = [];
  const ran: number[] = [];
  let live = true;
  const job = (i: number) => async () => void (ran.push(i), await new Promise<void>((r) => rel.push(r)));
  const all = [limit(() => live, job(1)), limit(() => live, job(2)), limit(() => live, job(3)), limit(() => true, job(4))];
  expect(ran).toEqual([1, 2]);
  live = false;
  rel[0]!();
  await new Promise((r) => setTimeout(r, 0));
  expect(ran).toEqual([1, 2, 4]);
  rel.forEach((r) => r());
  await Promise.all(all);
});
