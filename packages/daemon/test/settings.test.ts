import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createSettings, DEFAULTS } from "../src/settings.ts";

const file = () => join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json");

it("defaults with no file: orchestration off, cap 4, coordinator does not answer permissions (the user opts in)", () => {
  expect(createSettings({ file: file() }).get()).toEqual({ orchestration: { enabled: false, workerCap: 4, coordinatorPermissions: false } });
});

it("set persists; a new store (daemon process) reads the same values", () => {
  const f = file();
  createSettings({ file: f }).set({ orchestration: { enabled: true, workerCap: 7 } });
  expect(createSettings({ file: f }).get().orchestration).toEqual({ enabled: true, workerCap: 7, coordinatorPermissions: false });
});

it("a patch keeps another daemon's change to a different field", () => {
  const f = file();
  const a = createSettings({ file: f });
  const b = createSettings({ file: f });
  a.get();
  b.set({ orchestration: { enabled: true } });
  expect(a.set({ orchestration: { workerCap: 9 } }).orchestration).toMatchObject({ enabled: true, workerCap: 9 });
});

it("a corrupt file gives the defaults and is logged once", () => {
  const f = file();
  writeFileSync(f, "{nope");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const s = createSettings({ file: f });
  expect(s.get()).toEqual(DEFAULTS);
  s.get();
  expect(log).toHaveBeenCalledTimes(1);
  log.mockRestore();
});

it("an invalid hand-edited field falls back to its default, the valid ones stay", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ orchestration: { enabled: true, workerCap: 99, coordinatorPermissions: "yes" } }));
  expect(createSettings({ file: f }).get().orchestration).toEqual({ enabled: true, workerCap: 4, coordinatorPermissions: false });
});

it("a stored coordinatorPermissions keeps its value over the default", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ orchestration: { coordinatorPermissions: true } }));
  expect(createSettings({ file: f }).get().orchestration.coordinatorPermissions).toBe(true);
});

it("refuses a cap outside 1-20, a non-integer, an unknown field; nothing is written", () => {
  const f = file();
  const s = createSettings({ file: f });
  for (const workerCap of [0, 21, 2.5, "3"]) expect(() => s.set({ orchestration: { workerCap } as never })).toThrow("Maximum workers must be a whole number from 1 to 20");
  expect(() => s.set({ orchestration: { nope: 1 } } as never)).toThrow(/orchestration.nope/);
  expect(() => s.set({ other: {} } as never)).toThrow(/unknown setting/);
  expect(() => readFileSync(f)).toThrow();
});

it("refuses __proto__ and inherited names as section or field; Object.prototype and the file stay unchanged", () => {
  const f = file();
  const s = createSettings({ file: f });
  s.set({ orchestration: { workerCap: 5 } });
  const before = readFileSync(f, "utf8");
  const polluted = JSON.parse('{"__proto__":{"x":1,"toString":1}}');
  for (const patch of [polluted, JSON.parse('{"orchestration":{"__proto__":{"x":1}}}'), { orchestration: { toString: 1 } }, { orchestration: { hasOwnProperty: true } }, { toString: {} }, { constructor: {} }])
    expect(() => s.set(patch as never)).toThrow();
  expect(({} as Record<string, unknown>).x).toBeUndefined();
  expect(typeof ({}).toString).toBe("function");
  expect(readFileSync(f, "utf8")).toBe(before);
});

it("an old file with coordinatorAnswersPermissions: true (saved before the field was a choice) reads as off; the old key goes on the next write", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ orchestration: { enabled: true, workerCap: 4, coordinatorAnswersPermissions: true } }));
  const s = createSettings({ file: f });
  expect(s.get().orchestration).toEqual({ enabled: true, workerCap: 4, coordinatorPermissions: false });
  // The stored default workerCap goes too: it follows a later default change.
  s.set({ orchestration: { enabled: true } });
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { enabled: true } });
});

it("the file keeps only fields that differ from their default", () => {
  const f = file();
  const s = createSettings({ file: f });
  s.set({ orchestration: { enabled: true, workerCap: 4, coordinatorPermissions: false } });
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { enabled: true } });
  s.set({ orchestration: { coordinatorPermissions: true } });
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { enabled: true, coordinatorPermissions: true } });
  s.set({ orchestration: { enabled: false } });
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { coordinatorPermissions: true } });
});
