// Addon dev mode (docs/spec.md "Addon dev mode"): a watcher on the folder of a local addon bumps `rev` and broadcasts; capabilities never grow without approval; the watcher never leaks.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAddons } from "../src/addons.ts";
import type { AddonsListResult } from "@claude-ui/protocol";
import { canSymlink } from "./symlink-support.ts";

type Listener = (event: string, file: string | null) => void;
type Fake = { path: string; opts: { recursive: boolean }; emit: Listener; fail: () => void; closed: boolean };

const BASE = { name: "example", version: "1.0.0", description: "d", capabilities: ["ui.pane"], views: [{ id: "stats", title: "Stats", entry: "pane.html", kind: "pane" }], themes: [{ id: "t", name: "T", css: "t.css" }] };

let tmp: string;
let root: string;
let watchers: Fake[];
let changed: number;
let created: ReturnType<typeof createAddons>[];

const write = (patch: Record<string, unknown> = {}) => writeFileSync(join(root, "addon.json"), JSON.stringify({ ...BASE, ...patch }));
const open = () => watchers.filter((w) => !w.closed);

function make() {
  const a = createAddons({
    dir: join(tmp, "config"),
    file: join(tmp, "config", "addons.json"),
    onChanged: () => void changed++,
    devDebounceMs: 150,
    watch: (path, opts, cb) => {
      const w: Fake = { path, opts, emit: cb, closed: false, fail: () => errors.forEach((f) => f()) };
      const errors: (() => void)[] = [];
      watchers.push(w);
      return { close: () => void (w.closed = true), on: (_e: "error", f: () => void) => void errors.push(f) };
    },
  });
  created.push(a);
  return a;
}
const call = (a: ReturnType<typeof createAddons>, msg: Record<string, unknown>) => a.handle({ reqId: "r", ...msg } as never);
const list = async (a: ReturnType<typeof createAddons>) => ((await call(a, { type: "addons.list" })) as AddonsListResult).addons;
const one = async (a: ReturnType<typeof createAddons>) => (await list(a))[0]!;
/** Install `root` as a local addon, approve and enable it, turn dev on. */
async function devAddon() {
  const a = make();
  await call(a, { type: "addons.install", source: { kind: "local", path: root } });
  await call(a, { type: "addons.approve", name: "example", capabilities: ["ui.pane"] });
  await call(a, { type: "addons.setDev", name: "example", dev: true });
  return a;
}
const settle = () => vi.advanceTimersByTimeAsync(150);

beforeEach(() => {
  vi.useFakeTimers();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "addon-dev-")));
  root = join(tmp, "folder");
  mkdirSync(root);
  write();
  for (const f of ["pane.html", "t.css"]) writeFileSync(join(root, f), "x");
  watchers = [];
  changed = 0;
  created = [];
});
afterEach(() => {
  created.forEach((a) => a.close());
  vi.useRealTimers();
  rmSync(tmp, { recursive: true, force: true });
});

describe("dev mode watcher", () => {
  it("watches the addon folder only, recursive; a burst of edits gives one change and a new rev", async () => {
    const a = await devAddon();
    expect(watchers).toHaveLength(1);
    expect(watchers[0]).toMatchObject({ path: root, opts: { recursive: true } });
    const before = await one(a);
    expect(before).toMatchObject({ dev: true, state: "enabled" });
    const n = changed;
    for (const f of ["t.css", "t.css", "pane.html"]) watchers[0]!.emit("change", f);
    await vi.advanceTimersByTimeAsync(149);
    expect(changed).toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toBe(n + 1);
    expect((await one(a)).rev).toBeGreaterThan(before.rev!);
  });

  it("ignores .git and node_modules", async () => {
    await devAddon();
    const n = changed;
    watchers[0]!.emit("change", ".git/index");
    watchers[0]!.emit("rename", "node_modules/x/y.js");
    await settle();
    expect(changed).toBe(n);
  });

  it("is off for an addon without dev: no watcher, no rev", async () => {
    const a = make();
    await call(a, { type: "addons.install", source: { kind: "local", path: root } });
    await call(a, { type: "addons.approve", name: "example", capabilities: ["ui.pane"] });
    expect(watchers).toHaveLength(0);
    expect(await one(a)).not.toHaveProperty("rev");
    expect(await one(a)).not.toHaveProperty("dev");
  });

  it("only a local folder can be watched", async () => {
    const a = make();
    await expect(call(a, { type: "addons.setDev", name: "nope", dev: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(call(a, { type: "addons.setDev", name: "example", dev: "yes" as never })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("starts again after a restart of the daemon", async () => {
    await devAddon();
    expect(open()).toHaveLength(1);
    created.forEach((a) => a.close());
    expect(open()).toHaveLength(0);
    make();
    expect(open()).toHaveLength(1);
  });
});

describe("watcher never leaks", () => {
  it("closes on disable, dev off, uninstall and close; reopens on enable", async () => {
    const a = await devAddon();
    await call(a, { type: "addons.setEnabled", name: "example", enabled: false });
    expect(open()).toHaveLength(0);
    await call(a, { type: "addons.setEnabled", name: "example", enabled: true });
    expect(open()).toHaveLength(1);
    await call(a, { type: "addons.setDev", name: "example", dev: false });
    expect(open()).toHaveLength(0);
    await call(a, { type: "addons.setDev", name: "example", dev: true });
    expect(open()).toHaveLength(1);
    await call(a, { type: "addons.uninstall", name: "example" });
    expect(open()).toHaveLength(0);
    expect(watchers.length).toBe(3);
  });

  it("turning dev on twice opens one watcher", async () => {
    const a = await devAddon();
    await call(a, { type: "addons.setDev", name: "example", dev: true });
    expect(watchers).toHaveLength(1);
  });

  it("close() drops a pending change: nothing fires after it", async () => {
    const a = await devAddon();
    const n = changed;
    watchers[0]!.emit("change", "t.css");
    a.close();
    await settle();
    expect(changed).toBe(n);
    expect(open()).toHaveLength(0);
  });

  it("a watcher error closes it and the addon stays usable", async () => {
    const a = await devAddon();
    watchers[0]!.fail();
    expect(open()).toHaveLength(0);
    expect(await one(a)).toMatchObject({ state: "enabled" });
  });

  it("a folder that cannot be watched does not throw", async () => {
    const a = createAddons({
      dir: join(tmp, "config"),
      file: join(tmp, "config", "addons.json"),
      onChanged: () => {},
      watch: () => {
        throw new Error("ENOSPC");
      },
    });
    created.push(a);
    await call(a, { type: "addons.install", source: { kind: "local", path: root } });
    await call(a, { type: "addons.approve", name: "example", capabilities: ["ui.pane"] });
    await expect(call(a, { type: "addons.setDev", name: "example", dev: true })).resolves.toMatchObject({ dev: true });
  });
});

describe("capabilities never grow without approval", () => {
  it("same set: no prompt", async () => {
    const a = await devAddon();
    write({ version: "1.0.1" });
    watchers[0]!.emit("change", "addon.json");
    await settle();
    expect(await one(a)).toMatchObject({ state: "enabled" });
  });

  it("a new capability needs approval, stops serving and closes the watcher", async () => {
    const a = await devAddon();
    expect(a.serve("example", "t.css")).toBeDefined();
    write({ capabilities: ["ui.pane", "ui.toast"] });
    watchers[0]!.emit("change", "addon.json");
    await settle();
    expect(await one(a)).toMatchObject({ state: "needs_approval", approved: ["ui.pane"] });
    expect(a.serve("example", "t.css")).toBeUndefined();
    expect(open()).toHaveLength(0);
  });

  it("a capability removed and declared again keeps its approval (subset of the approved set)", async () => {
    const a = make();
    write({ capabilities: ["ui.pane", "ui.toast"] });
    await call(a, { type: "addons.install", source: { kind: "local", path: root } });
    await call(a, { type: "addons.approve", name: "example", capabilities: ["ui.pane", "ui.toast"] });
    await call(a, { type: "addons.setDev", name: "example", dev: true });
    write(); // ui.toast removed: fewer capabilities, no prompt
    watchers[0]!.emit("change", "addon.json");
    await settle();
    expect(await one(a)).toMatchObject({ state: "enabled", approved: ["ui.pane", "ui.toast"] });
    write({ capabilities: ["ui.pane", "ui.toast"] });
    watchers[0]!.emit("change", "addon.json");
    await settle();
    expect(await one(a)).toMatchObject({ state: "enabled" });
  });
});

describe("manifest error while editing", () => {
  it("keeps the last good manifest and files, shows the error, clears it when fixed", async () => {
    const a = await devAddon();
    writeFileSync(join(root, "addon.json"), "{ not json");
    watchers[0]!.emit("change", "addon.json");
    await settle();
    const bad = await one(a);
    expect(bad).toMatchObject({ state: "enabled", error: "addon.json is not valid JSON" });
    expect(bad.manifest?.name).toBe("example");
    expect(a.serve("example", "t.css")).toBeDefined();
    write();
    watchers[0]!.emit("change", "addon.json");
    await settle();
    expect(await one(a)).not.toHaveProperty("error");
  });

  it("without dev a broken manifest is an error state as before", async () => {
    const a = make();
    await call(a, { type: "addons.install", source: { kind: "local", path: root } });
    await call(a, { type: "addons.approve", name: "example", capabilities: ["ui.pane"] });
    writeFileSync(join(root, "addon.json"), "{ not json");
    expect(await one(a)).toMatchObject({ state: "error" });
    expect(a.serve("example", "t.css")).toBeUndefined();
  });

  it("a manifest that was never good has no fallback", async () => {
    const a = await devAddon();
    created.forEach((x) => x.close());
    writeFileSync(join(root, "addon.json"), "{ not json");
    const b = make(); // fresh process: no last good manifest
    expect(await one(b)).toMatchObject({ state: "error" });
  });
});

describe("files come only from the addon folder", () => {
  it("a dot-dot path or a link out of the folder is not served in dev mode", async () => {
    const a = await devAddon();
    writeFileSync(join(tmp, "secret.css"), "x");
    expect(a.serve("example", "..%2Fsecret.css")).toBeUndefined();
    expect(a.serve("example", "../secret.css")).toBeUndefined();
    if (canSymlink) {
      symlinkSync(join(tmp, "secret.css"), join(root, "link.css"));
      expect(a.serve("example", "link.css")).toBeUndefined();
    }
  });
});
