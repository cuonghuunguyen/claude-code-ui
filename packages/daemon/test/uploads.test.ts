import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { configDir } from "../src/token.ts";
import { createUploads, defaultUploadsDir } from "../src/uploads.ts";

const posix = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "uploads-test-"));
const ID_A = "3f2a1b4c-0000-4000-8000-000000000001";
const ID_B = "3f2a1b4c-0000-4000-8000-000000000002";
const T = "a".repeat(64);

describe("uploads", () => {
  it.skipIf(!posix)("creates the parent 0700 and each session folder 0700, files 0600", () => {
    const dir = join(tmp(), "parent");
    const up = createUploads({ dir });
    const folder = up.dirFor(ID_A);
    const file = up.store(ID_A, "a.txt", Buffer.from("x"));
    expect(up.parent).toBe(dir);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(folder).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!posix)("uses a parent of another user only as a fallback", () => {
    const dir = tmp();
    const up = createUploads({ dir, uid: process.getuid!() + 1 });
    expect(up.parent).not.toBe(dir);
    expect(createUploads({ dir, uid: process.getuid!() }).parent).toBe(dir);
  });

  it.skipIf(!posix)("tightens an existing parent and session folder to 0700", () => {
    const dir = join(tmp(), "p");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const up = createUploads({ dir });
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    mkdirSync(join(dir, ID_A), { mode: 0o755 });
    chmodSync(join(dir, ID_A), 0o755);
    up.dirFor(ID_A);
    expect(lstatSync(join(dir, ID_A)).mode & 0o777).toBe(0o700);
  });

  it("a claimed draft token is refused for uploads", () => {
    const up = createUploads({ dir: tmp() });
    up.ownerOfDraft(T);
    up.claim(T);
    expect(up.ownerOfDraft(T)).toBeUndefined();
    expect(up.draftClaimed(T)).toBe(true);
  });

  it("rejects a session id that is not a lowercase UUID", () => {
    const dir = join(tmp(), "p");
    const up = createUploads({ dir });
    for (const id of ["../x", ID_A.toUpperCase(), "", "..", `${ID_A}/..`]) expect(() => up.dirFor(id)).toThrow();
    expect(() => up.store("../x", "a", Buffer.alloc(0))).toThrow();
    expect(existsSync(join(dir, "..", "x"))).toBe(false);
  });

  it("store keeps the name under u-XXXXXX in the session folder", () => {
    const dir = tmp();
    const up = createUploads({ dir });
    const sep = "[\\\\/]";
    const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const re = (n: string) => new RegExp(`${esc(dir)}${sep}${ID_A}${sep}u-[A-Za-z0-9]{6}${sep}${esc(n)}$`);
    expect(up.store(ID_A, "notes.txt", Buffer.from("hi"))).toMatch(re("notes.txt"));
    expect(up.store(ID_A, "../notes.txt", Buffer.from("hi"))).toMatch(re("notes.txt"));
    expect(up.store(ID_A, ".env", Buffer.from("hi"))).toMatch(re("env"));
    expect(readFileSync(up.store(ID_A, "c", Buffer.from("body")), "utf8")).toBe("body");
  });

  it("a draft token maps to one id until claimed; a claim is one-shot", () => {
    const up = createUploads({ dir: tmp() });
    const id = up.ownerOfDraft(T);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(up.ownerOfDraft(T)).toBe(id);
    expect(up.hasDraftId(id!)).toBe(true);
    expect(up.claim(T)).toBe(id);
    expect(up.claim(T)).toBeUndefined();
    expect(up.ownerOfDraft(T)).toBeUndefined();
    for (const bad of ["x", "a".repeat(63), "A".repeat(64)]) {
      expect(up.ownerOfDraft(bad)).toBeUndefined();
      expect(up.claim(bad)).toBeUndefined();
    }
    expect(up.claim("b".repeat(64))).toBeUndefined();
  });

  it("a draft token expires after 24 h", () => {
    let now = 1_000_000;
    const up = createUploads({ dir: tmp(), now: () => now });
    const id = up.ownerOfDraft(T);
    now += 24 * 3600_000 + 1;
    expect(up.claim(T)).toBeUndefined();
    expect(up.ownerOfDraft(T)).not.toBe(id);
  });

  it("hasDraftId honours the expiry, so an abandoned draft folder can be swept", () => {
    let now = 1_000_000;
    const up = createUploads({ dir: tmp(), now: () => now });
    const id = up.ownerOfDraft(T)!;
    expect(up.hasDraftId(id)).toBe(true);
    now += 24 * 3600_000 + 1;
    expect(up.hasDraftId(id)).toBe(false);
  });

  it("caps the draft map by dropping the oldest", () => {
    let now = 1;
    const up = createUploads({ dir: tmp(), now: () => now++ });
    const first = up.ownerOfDraft("0".repeat(64));
    for (let i = 1; i <= 1000; i++) up.ownerOfDraft(i.toString(16).padStart(64, "0"));
    expect(up.hasDraftId(first!)).toBe(false);
  });

  it.skipIf(!posix)("refuses a symlinked parent or session folder", () => {
    const base = tmp();
    const target = join(base, "target");
    mkdirSync(target);
    const link = join(base, "link");
    symlinkSync(target, link);
    const up = createUploads({ dir: link });
    expect(up.parent).not.toBe(link);
    expect(lstatSync(up.parent).isSymbolicLink()).toBe(false);

    const dir = join(base, "parent");
    const ok = createUploads({ dir });
    symlinkSync(target, join(dir, ID_A));
    expect(() => ok.dirFor(ID_A)).toThrow();
    expect(() => ok.store(ID_A, "a", Buffer.from("x"))).toThrow();
    expect(existsSync(join(target, "a"))).toBe(false);
  });

  it("remove deletes only that session's folder", async () => {
    const base = tmp();
    const dir = join(base, "p");
    const up = createUploads({ dir });
    const a = up.store(ID_A, "a", Buffer.from("x"));
    const b = up.store(ID_B, "b", Buffer.from("x"));
    up.ownerOfDraft(T);
    await up.remove(ID_A);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(join(dir, ID_A))).toBe(false);
    expect(existsSync(b)).toBe(true);
    await up.remove("../p");
    await up.remove("");
    expect(existsSync(b)).toBe(true);
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "k");
    if (posix) {
      const other = "3f2a1b4c-0000-4000-8000-000000000003";
      symlinkSync(outside, join(dir, other));
      await up.remove(other);
      expect(existsSync(join(dir, other))).toBe(false);
      expect(existsSync(join(outside, "keep"))).toBe(true);
    }
  });

  it("remove drops the draft entries of that id", async () => {
    const up = createUploads({ dir: tmp() });
    const id = up.ownerOfDraft(T)!;
    await up.remove(id);
    expect(up.hasDraftId(id)).toBe(false);
  });

  it("sweep removes old unknown folders only", async () => {
    const dir = join(tmp(), "p");
    const up = createUploads({ dir });
    const ids = ["1", "2", "3", "4"].map((n) => `3f2a1b4c-0000-4000-8000-00000000001${n}`);
    const age = (id: string, h: number) => {
      const t = new Date(Date.now() - h * 3600_000);
      const f = up.store(id, "f", Buffer.from("x"));
      for (const p of [f, join(f, ".."), join(f, "..", ".."), ]) utimesSync(p, t, t);
    };
    age(ids[0]!, 25); // known, old
    age(ids[1]!, 1); // unknown, young
    age(ids[2]!, 25); // unknown, old
    mkdirSync(join(dir, "foo"));
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(join(dir, "foo"), old, old);
    const removed = await up.sweep((id) => id === ids[0]);
    expect(removed).toEqual([ids[2]]);
    expect(existsSync(join(dir, ids[0]!))).toBe(true);
    expect(existsSync(join(dir, ids[1]!))).toBe(true);
    expect(existsSync(join(dir, ids[2]!))).toBe(false);
    expect(existsSync(join(dir, "foo"))).toBe(true);
  });

  it("sweep keeps a folder whose draft is live", async () => {
    const dir = join(tmp(), "p");
    const up = createUploads({ dir });
    const id = up.ownerOfDraft(T)!;
    const f = up.store(id, "f", Buffer.from("x"));
    const t = new Date(Date.now() - 48 * 3600_000);
    for (const p of [f, join(f, ".."), join(f, "..", "..")]) utimesSync(p, t, t);
    expect(await up.sweep((i) => up.hasDraftId(i))).toEqual([]);
  });
});

describe("defaultUploadsDir", () => {
  it("is %LOCALAPPDATA%\\claude-ui\\uploads on Windows, else under the config dir", () => {
    expect(defaultUploadsDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", APPDATA: "C:\\R" }, "win32")).toBe(win32.join("C:\\Users\\me\\AppData\\Local", "claude-ui", "uploads"));
    const env = { APPDATA: "C:\\R", XDG_CONFIG_HOME: undefined };
    expect(defaultUploadsDir(env, "win32", configDir(env, "win32", () => false))).toBe(join(configDir(env, "win32", () => false), "uploads"));
    expect(defaultUploadsDir({ XDG_CONFIG_HOME: "/x/cfg" }, "linux")).toBe(join("/x/cfg", "claude-ui", "uploads"));
  });
});
