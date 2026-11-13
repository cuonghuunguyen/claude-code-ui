import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  appendAndPrune,
  createBrowserLogger,
  installBrowserLogs,
  logFileName,
  MAX_AGE_MS,
  MAX_ENTRIES,
  openLogDb,
  redact,
  saveKeepLogs,
  serializeArgs,
  stats,
  type LogEntry,
} from "./browser-logs.ts";

const TOKEN = "abcDEF0123456789xyz";
const entry = (i: number, time = 1_000_000 + i): LogEntry => ({ time, level: "log", message: `entry ${i}`, path: "/", version: "t" });
/** A timer that never fires on its own: tests flush explicitly. */
const noTimer = () => () => undefined;
const make = (over: Parameters<typeof createBrowserLogger>[0] = {}) =>
  createBrowserLogger({ factory: new IDBFactory(), path: () => "/p", version: "1.2.3", setTimer: noTimer, token: () => undefined, ...over });
const fakeConsole = () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const lines = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry & { time: string });

describe("serializeArgs", () => {
  it("joins strings, objects and Errors with stack; marks cycles", () => {
    const e = new Error("boom");
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const out = serializeArgs(["x", { k: 1 }, e, cyc, undefined, 5n]);
    expect(out).toContain('x {"k":1}');
    expect(out).toContain(e.stack!.split("\n")[1]!.trim());
    expect(out).toContain('"self":"[Circular]"');
    expect(out).toContain("undefined 5");
  });
  it("caps a message at 8192 characters", () => {
    const out = serializeArgs(["a".repeat(20000)]);
    expect(out).toHaveLength(8192);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });
});

describe("redact", () => {
  const inputs = [
    `http://h/#token=${TOKEN}`,
    `/media?a=1&token=${TOKEN}&b=2`,
    `token.${TOKEN}`,
    `Authorization: Bearer ${TOKEN}`,
    `{"authorization":"Bearer ${TOKEN}"}`,
    `sent bearer ${TOKEN} ok`,
  ];
  it("removes the pairing token from fragment, query, subprotocol, bearer and authorization", () => {
    for (const input of inputs) {
      const out = redact(input);
      expect(out).not.toContain(TOKEN);
      expect(out).toContain("[redacted]");
    }
    expect(redact(inputs[1]!)).toContain("&b=2");
  });
  it("removes the stored token anywhere", () => {
    expect(redact(`connect failed for ${TOKEN} at host`, TOKEN)).toBe("connect failed for [redacted] at host");
  });
});

describe("logger", () => {
  it("console wrapper calls the original console and stores the entry", async () => {
    const c = fakeConsole();
    const orig = c.error;
    const logger = make();
    installBrowserLogs(logger, { console: c, window: new EventTarget() });
    c.error("bad", 42);
    expect(orig).toHaveBeenCalledWith("bad", 42);
    const [line] = lines(await logger.exportText());
    expect(line).toMatchObject({ level: "error", message: "bad 42", path: "/p", version: "1.2.3" });
  });

  it("window error and unhandled rejection are stored with stack", async () => {
    const win = new EventTarget();
    const logger = make();
    installBrowserLogs(logger, { console: fakeConsole(), window: win });
    const err = new Error("kaboom");
    win.dispatchEvent(Object.assign(new Event("error"), { error: err, message: "kaboom" }));
    win.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("boom") }));
    win.dispatchEvent(new Event("error")); // resource load error: ignored
    const out = lines(await logger.exportText());
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ level: "error" });
    expect(out[0]!.message).toMatch(/^Uncaught .*kaboom[\s\S]*at /);
    expect(out[1]!.message).toMatch(/^Unhandled rejection: .*boom[\s\S]*at /);
  });

  it("stores no token", async () => {
    const logger = make({ token: () => TOKEN });
    logger.capture("error", [`open http://h/#token=${TOKEN}`, `raw ${TOKEN}`]);
    expect(await logger.exportText()).not.toContain(TOKEN);
  });

  it("entries survive a new logger on the same database", async () => {
    const factory = new IDBFactory();
    const a = make({ factory });
    a.capture("warn", ["before reload"]);
    await a.flush();
    const b = make({ factory });
    expect(lines(await b.exportText()).map((l) => l.message)).toEqual(["before reload"]);
  });

  it("export is oldest first, one JSON object per line", async () => {
    let t = Date.parse("2026-11-14T10:00:00Z");
    const logger = make({ now: () => (t += 1000) });
    logger.capture("log", ["one"]);
    logger.capture("info", ["two"]);
    const text = await logger.exportText();
    expect(text.endsWith("\n")).toBe(true);
    const out = lines(text);
    expect(out.map((l) => l.message)).toEqual(["one", "two"]);
    expect(Date.parse(out[0]!.time as unknown as string)).toBeLessThan(Date.parse(out[1]!.time as unknown as string));
    expect(out[0]!.time as unknown as string).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it("buffer flushes at 100 entries and after 1 s", async () => {
    let fire: (() => void) | undefined;
    const factory = new IDBFactory();
    const logger = make({ factory, setTimer: (fn, ms) => { expect(ms).toBe(1000); fire = fn; return () => { fire = undefined; }; } });
    const count = async () => {
      const db = await openLogDb(factory);
      return (await stats(db)).count;
    };
    logger.capture("log", ["a"]);
    expect(fire).toBeDefined();
    fire!();
    await vi.waitFor(async () => expect(await count()).toBe(1));
    for (let i = 0; i < 100; i++) logger.capture("log", [i]);
    await vi.waitFor(async () => expect(await count()).toBe(101));
  });

  it("an overfull buffer drops entries and reports it once", async () => {
    const logger = make();
    for (let i = 0; i < 1100; i++) logger.capture("log", [i]);
    await logger.flush();
    await logger.flush();
    const out = lines(await logger.exportText());
    expect(out.some((l) => /browser logs: \d+ entries dropped/.test(l.message))).toBe(true);
  });

  it("storage unavailable: capture never throws and state is unavailable", async () => {
    const factory = { open: () => { throw new Error("blocked"); } } as unknown as IDBFactory;
    const c = fakeConsole();
    const orig = c.error;
    const logger = make({ factory });
    installBrowserLogs(logger, { console: c, window: new EventTarget() });
    expect(() => c.error("x")).not.toThrow();
    expect(orig).toHaveBeenCalledTimes(1);
    expect(await logger.exportText()).toBe("");
    expect(logger.state()).toBe("unavailable");
    expect(() => c.error("y")).not.toThrow();
    expect(orig).toHaveBeenCalledTimes(2);
  });

  it("a failing write does not log into the logger", async () => {
    const real = new IDBFactory();
    const factory = {
      open: (...a: [string, number]) => {
        const req = real.open(...a);
        req.addEventListener("success", () => {
          req.result.transaction = () => { throw new Error("quota"); };
        });
        return req;
      },
    } as unknown as IDBFactory;
    const c = fakeConsole();
    const orig = { ...c };
    const logger = make({ factory });
    installBrowserLogs(logger, { console: c, window: new EventTarget() });
    c.error("one");
    await logger.flush();
    c.warn("two");
    await logger.flush();
    expect(orig.error).toHaveBeenCalledTimes(1);
    expect(orig.warn).toHaveBeenCalledTimes(1);
    expect(logger.state()).toBe("ready");
  });

  it("turning the setting off clears the store and stops capture", async () => {
    const logger = make();
    logger.capture("log", ["kept"]);
    await logger.flush();
    expect((await logger.stats()).count).toBe(1);
    saveKeepLogs(false, logger);
    expect((await logger.stats()).count).toBe(0);
    logger.capture("log", ["ignored"]);
    expect((await logger.stats()).count).toBe(0);
    saveKeepLogs(true, logger);
    logger.capture("log", ["again"]);
    expect((await logger.stats()).count).toBe(1);
  });
});

describe("ring buffer", () => {
  it("the store keeps the newest 5000 entries", async () => {
    const factory = new IDBFactory();
    const db = await openLogDb(factory);
    const now = 2_000_000;
    for (let from = 0; from < 5100; from += 1000) {
      await appendAndPrune(db, Array.from({ length: Math.min(1000, 5100 - from) }, (_, i) => entry(from + i, now - 1000)), now);
    }
    expect((await stats(db)).count).toBe(MAX_ENTRIES);
    const logger = make({ factory, now: () => now });
    expect(lines(await logger.exportText())[0]!.message).toBe("entry 100");
  });

  it("entries older than 7 days are dropped", async () => {
    const factory = new IDBFactory();
    const db = await openLogDb(factory);
    const now = 10 * MAX_AGE_MS;
    await appendAndPrune(db, [entry(0, now - MAX_AGE_MS - 1), entry(1, now - MAX_AGE_MS + 1000), entry(2, now)], now);
    const logger = make({ factory, now: () => now });
    expect(lines(await logger.exportText()).map((l) => l.message)).toEqual(["entry 1", "entry 2"]);
  });
});

describe("logFileName", () => {
  it("uses the local date", () => {
    expect(logFileName(new Date(2026, 10, 14, 23, 59))).toBe("claude-ui-browser-logs-2026-11-14.log");
  });
});
