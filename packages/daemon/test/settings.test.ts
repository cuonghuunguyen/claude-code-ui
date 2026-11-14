import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { checkPatch, createSettings, DEFAULTS, parseSettings } from "../src/settings.ts";

const GIT = { autoRepositoryDetection: true, repositoryScanMaxDepth: 1, repositoryScanIgnoredFolders: ["node_modules"], scanRepositories: [], ignoredRepositories: [], detectSubmodules: true, detectSubmodulesLimit: 10, ignoreSubmodules: false, openRepositoryInParentFolders: "always", commitMessageInstruction: "", commitMessageInstructions: {} };
const file = () => join(mkdtempSync(join(tmpdir(), "settings-")), "settings.json");

it("defaults with no file: orchestration off, cap 4, coordinator does not answer permissions (the user opts in)", () => {
  expect(createSettings({ file: file() }).get()).toEqual({ orchestration: { enabled: false, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, stallMinutes: 20, keepWarmMinutes: 55, coordinatorPermissions: false, workerMode: "coordinator", workerNotifications: true, closeFinished: true }, sessions: { defaultMode: "auto", engine: "claude" }, opencode: { path: "" }, usageLimit: { autoContinue: true }, focus: { nextForYou: false }, notifications: { desktop: true }, power: { keepAwake: false }, performance: { monitor: true }, chrome: { enabled: false }, chat: { visualize: true }, terminalAccess: { enabled: true }, inlineTask: { enabled: true, model: "haiku", openCodeModel: "", maxTurns: 10 }, fork: { enabled: true }, claude: { account: "" }, history: { enabled: true, exclude: ["**/node_modules/**", "**/.git/**"] }, jira: { url: "", email: "", template: "{type}/{key}-{summary}", jql: "" }, git: GIT, launcher: DEFAULTS.launcher, labels: { projects: {}, sides: {} }, editor: { command: "", name: "" }, back: { marks: {} }, app: { icon: "", name: "" } });
});

it("set persists; a new store (daemon process) reads the same values", () => {
  const f = file();
  createSettings({ file: f }).set({ orchestration: { enabled: true, workerCap: 7 } });
  expect(createSettings({ file: f }).get().orchestration).toEqual({ enabled: true, workerCap: 7, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, stallMinutes: 20, keepWarmMinutes: 55, coordinatorPermissions: false, workerMode: "coordinator", workerNotifications: true, closeFinished: true });
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

it("an invalid hand-edited field falls back to its default, the valid ones stay; a stored coordinatorPermissions keeps its value; a stored invalid workerMode falls back to coordinator", () => {
  {
    const f = file();
    writeFileSync(f, JSON.stringify({ orchestration: { enabled: true, workerCap: 99, coordinatorPermissions: "yes" } }));
    expect(createSettings({ file: f }).get().orchestration).toEqual({ enabled: true, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, stallMinutes: 20, keepWarmMinutes: 55, coordinatorPermissions: false, workerMode: "coordinator", workerNotifications: true, closeFinished: true });
  }
  {
    const f = file();
    writeFileSync(f, JSON.stringify({ orchestration: { coordinatorPermissions: true } }));
    expect(createSettings({ file: f }).get().orchestration.coordinatorPermissions).toBe(true);
  }
  {
    const f = file();
    writeFileSync(f, JSON.stringify({ orchestration: { enabled: true, workerMode: "bypassPermissions" } }));
    expect(createSettings({ file: f }).get().orchestration).toEqual({ enabled: true, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, stallMinutes: 20, keepWarmMinutes: 55, coordinatorPermissions: false, workerMode: "coordinator", workerNotifications: true, closeFinished: true });
  }
});


it("workerCapTotal defaults to 0 and takes 0 to 100; a stored workerCap keeps its value", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().orchestration.workerCapTotal).toBe(0);
  expect(s.set({ orchestration: { workerCapTotal: 100 } }).orchestration.workerCapTotal).toBe(100);
  for (const workerCapTotal of [-1, 101, 2.5, "3"]) expect(() => s.set({ orchestration: { workerCapTotal } as never })).toThrow("Maximum workers in total must be a whole number from 0 to 100");
  const g = file();
  writeFileSync(g, JSON.stringify({ orchestration: { workerCap: 7 } }));
  expect(createSettings({ file: g }).get().orchestration).toMatchObject({ workerCap: 7, workerCapTotal: 0 });
});

it("refuses a cap outside 1-20, a non-integer, an unknown field; nothing is written", () => {
  const f = file();
  const s = createSettings({ file: f });
  for (const workerCap of [0, 21, 2.5, "3"]) expect(() => s.set({ orchestration: { workerCap } as never })).toThrow("Maximum workers per tree must be a whole number from 1 to 20");
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
  expect(s.get().orchestration).toEqual({ enabled: true, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, stallMinutes: 20, keepWarmMinutes: 55, coordinatorPermissions: false, workerMode: "coordinator", workerNotifications: true, closeFinished: true });
  // The stored default workerCap goes too: it follows a later default change.
  s.set({ orchestration: { enabled: true } });
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { enabled: true } });
});

it("workerMode defaults to coordinator, accepts the five values, refuses others with 'Worker mode must be one of ...'", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().orchestration.workerMode).toBe("coordinator");
  for (const m of ["coordinator", "default", "acceptEdits", "plan", "auto"] as const) expect(s.set({ orchestration: { workerMode: m } }).orchestration.workerMode).toBe(m);
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { workerMode: "auto" } });
  for (const bad of ["bypassPermissions", "dontAsk", "", 1, null]) expect(() => s.set({ orchestration: { workerMode: bad as never } })).toThrow(/^Worker mode must be one of coordinator, default, acceptEdits, plan, auto$/);
  s.set({ orchestration: { workerMode: "coordinator", workerNotifications: true } });
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: {} });
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

it("focus.nextForYou defaults off, is saved when on, refuses a non-boolean; usageLimit.autoContinue defaults on, off is stored and read back, on is not stored, refuses a non-boolean", () => {
  {
    const f = file();
    const s = createSettings({ file: f });
    expect(s.get().focus).toEqual({ nextForYou: false });
    s.set({ focus: { nextForYou: true } });
    expect(createSettings({ file: f }).get().focus).toEqual({ nextForYou: true });
    expect(() => s.set({ focus: { nextForYou: "yes" as never } })).toThrow("Next for you suggestions on the Focus page must be on or off");
  }
  {
    const f = file();
    const s = createSettings({ file: f });
    expect(s.get().usageLimit).toEqual({ autoContinue: true });
    expect(s.set({ usageLimit: { autoContinue: false } }).usageLimit).toEqual({ autoContinue: false });
    expect(JSON.parse(readFileSync(f, "utf8")).usageLimit).toEqual({ autoContinue: false });
    expect(createSettings({ file: f }).get().usageLimit.autoContinue).toBe(false);
    s.set({ usageLimit: { autoContinue: true } });
    expect(JSON.parse(readFileSync(f, "utf8")).usageLimit?.autoContinue).toBeUndefined();
    expect(() => s.set({ usageLimit: { autoContinue: "yes" as never } })).toThrow("Continue automatically after a usage limit resets must be on or off");
  }
});


it("an install that saved nothing for autoContinue gets it on after the update (GH-524)", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ orchestration: { enabled: true } }));
  const g = createSettings({ file: f }).get();
  expect(g.usageLimit).toEqual({ autoContinue: true });
  expect(g.orchestration.enabled).toBe(true);
});

it("notifications.desktop is on by default, off is stored and read, true is not stored, a non-boolean in the file falls back (GH-158)", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().notifications).toEqual({ desktop: true });
  expect(s.set({ notifications: { desktop: false } }).notifications).toEqual({ desktop: false });
  expect(createSettings({ file: f }).get().notifications.desktop).toBe(false);
  s.set({ notifications: { desktop: true } });
  expect(JSON.parse(readFileSync(f, "utf8")).notifications?.desktop).toBeUndefined();
  writeFileSync(f, JSON.stringify({ notifications: { desktop: "no" } }));
  expect(createSettings({ file: f }).get().notifications.desktop).toBe(true);
});

it("a notifications patch with a non-boolean or an unknown field is refused", () => {
  const s = createSettings({ file: file() });
  expect(() => s.set({ notifications: { desktop: "x" as never } })).toThrow("Desktop notifications must be on or off");
  expect(() => s.set({ notifications: { foo: true } as never })).toThrow("unknown setting notifications.foo");
});

it("performance.monitor defaults to true and accepts a boolean; a string is refused", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().performance).toEqual({ monitor: true });
  expect(s.set({ performance: { monitor: false } }).performance).toEqual({ monitor: false });
  expect(() => s.set({ performance: { monitor: "x" as never } })).toThrow("Performance monitor must be on or off");
});

it("chrome.enabled defaults to off, saves, refuses a non-boolean", () => {
  const s = createSettings({ file: file() });
  expect(s.get().chrome).toEqual({ enabled: false });
  expect(s.set({ chrome: { enabled: true } }).chrome).toEqual({ enabled: true });
  expect(() => s.set({ chrome: { enabled: "yes" as never } })).toThrow("Claude in Chrome must be on or off");
});

it("workerNotifications defaults to on, saves off, refuses a non-boolean with 'Notifications from workers must be on or off'", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().orchestration.workerNotifications).toBe(true);
  expect(s.set({ orchestration: { workerNotifications: false } }).orchestration.workerNotifications).toBe(false);
  expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ orchestration: { workerNotifications: false } });
  expect(createSettings({ file: f }).get().orchestration.workerNotifications).toBe(false);
  for (const bad of ["off", 0, null]) expect(() => s.set({ orchestration: { workerNotifications: bad as never } })).toThrow(/^Notifications from workers must be on or off$/);
});

it("git arrays: default not stored, a changed array stored and read back, the default again removes it", () => {
  const f = file();
  const s = createSettings({ file: f });
  s.set({ git: { repositoryScanIgnoredFolders: ["node_modules"] } });
  expect(JSON.parse(readFileSync(f, "utf8")).git ?? {}).toEqual({});
  s.set({ git: { repositoryScanIgnoredFolders: ["node_modules", "dist"] } });
  expect(JSON.parse(readFileSync(f, "utf8")).git.repositoryScanIgnoredFolders).toEqual(["node_modules", "dist"]);
  expect(createSettings({ file: f }).get().git.repositoryScanIgnoredFolders).toEqual(["node_modules", "dist"]);
  s.set({ git: { repositoryScanIgnoredFolders: ["node_modules"] } });
  expect(JSON.parse(readFileSync(f, "utf8")).git).toEqual({});
  s.get().git.repositoryScanIgnoredFolders.push("x");
  expect(s.get().git.repositoryScanIgnoredFolders).toEqual(["node_modules"]);
  expect(DEFAULTS.git.repositoryScanIgnoredFolders).toEqual(["node_modules"]);
});

it("git arrays refuse more than 50 entries, an entry over 260 chars, NUL, a non-string, an empty entry", () => {
  const f = file();
  const s = createSettings({ file: f });
  const bad: unknown[] = [Array.from({ length: 51 }, (_, i) => `d${i}`), ["a".repeat(261)], ["a\0b"], [1], [""], "x"];
  for (const v of bad) expect(() => s.set({ git: { ignoredRepositories: v as never } })).toThrow("Ignored repositories must be");
  expect(() => readFileSync(f)).toThrow();
});

it("scanRepositories refuses absolute, .., .git and backslash-absolute entries", () => {
  const s = createSettings({ file: file() });
  for (const v of ["/x", "\\x", "C:\\x", "a/../b", "a/.git", ".GIT", "..", "."]) expect(() => s.set({ git: { scanRepositories: [v] } })).toThrow("Scan repositories must be");
  expect(s.set({ git: { scanRepositories: ["libs/a"] } }).git.scanRepositories).toEqual(["libs/a"]);
});

it("repositoryScanIgnoredFolders refuses a path, only a folder name", () => {
  const s = createSettings({ file: file() });
  expect(() => s.set({ git: { repositoryScanIgnoredFolders: ["a/b"] } })).toThrow("Repository scan ignored folders must be");
});

it("git scalars: depth -1..10 integers, limit 0..100, detection four values, parent folders three values, booleans", () => {
  const s = createSettings({ file: file() });
  for (const git of [{ repositoryScanMaxDepth: -1 }, { repositoryScanMaxDepth: 10 }, { detectSubmodulesLimit: 0 }, { detectSubmodulesLimit: 100 }, { autoRepositoryDetection: "subFolders" }, { autoRepositoryDetection: false }, { openRepositoryInParentFolders: "prompt" }, { ignoreSubmodules: true }, { detectSubmodules: false }]) expect(() => s.set({ git } as never)).not.toThrow();
  for (const git of [{ repositoryScanMaxDepth: -2 }, { repositoryScanMaxDepth: 11 }, { repositoryScanMaxDepth: 1.5 }, { detectSubmodulesLimit: 101 }, { detectSubmodulesLimit: -1 }, { autoRepositoryDetection: "yes" }, { openRepositoryInParentFolders: "ask" }, { ignoreSubmodules: 1 }, { detectSubmodules: "on" }]) expect(() => s.set({ git } as never)).toThrow(/must be/);
});

it("a stored invalid git field falls back to its default", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ git: { repositoryScanMaxDepth: 99, scanRepositories: ["/abs"], detectSubmodulesLimit: 5 } }));
  expect(createSettings({ file: f }).get().git).toEqual({ ...GIT, detectSubmodulesLimit: 5 });
});

it("maxDepth and maxChildren default to 2 and 4 and refuse values out of range", () => {
  const s = createSettings({ file: file() });
  expect(s.get().orchestration).toMatchObject({ maxDepth: 2, maxChildren: 4 });
  for (const maxDepth of [0, 6, 1.5]) expect(() => s.set({ orchestration: { maxDepth } as never })).toThrow("Maximum tree depth must be a whole number from 1 to 5");
  for (const maxChildren of [0, 21]) expect(() => s.set({ orchestration: { maxChildren } as never })).toThrow("Maximum workers per coordinator must be a whole number from 1 to 20");
  expect(s.set({ orchestration: { maxDepth: 3, maxChildren: 9 } }).orchestration).toMatchObject({ maxDepth: 3, maxChildren: 9 });
});

it("Jira URL: a new value is https, or http only for localhost and 127.0.0.1; a stored non-local http stays (GH-451)", () => {
  const s = createSettings({ file: file() });
  const rule = "Jira URL must be empty or an https address without user name or password (http only for localhost or 127.0.0.1)";
  expect(checkPatch({ jira: { url: "http://jira.example.com" } })).toBe(rule);
  for (const url of ["https://jira.example.com/jira", "http://localhost:8080/jira", "http://127.0.0.1:9", ""]) expect(checkPatch({ jira: { url } })).toBeUndefined();
  expect(() => s.set({ jira: { url: "http://jira.example.com" } })).toThrow(rule);
  const f = file();
  writeFileSync(f, JSON.stringify({ jira: { url: "http://jira.example.com" } }));
  expect(createSettings({ file: f }).get().jira.url).toBe("http://jira.example.com");
});

it("power.keepAwake defaults off, is saved and refused unless on or off (GH-523)", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().power.keepAwake).toBe(false);
  s.set({ power: { keepAwake: true } });
  expect(createSettings({ file: f }).get().power.keepAwake).toBe(true);
  expect(() => s.set({ power: { keepAwake: "yes" as never } })).toThrow("Keep computer awake must be on or off");
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";

it("labels: a valid map is saved, read back, and {} removes it from the file", () => {
  const f = file();
  const s = createSettings({ file: f });
  const projects = { "/work/app": { name: "App", icon: "🚀" }, "/work/img": { icon: PNG } };
  expect(s.set({ labels: { projects } }).labels).toEqual({ projects, sides: {} });
  expect(createSettings({ file: f }).get().labels.projects).toEqual(projects);
  s.set({ labels: { projects: {} } });
  expect(JSON.parse(readFileSync(f, "utf8")).labels?.projects).toBeUndefined();
});

it("labels: invalid entries are refused", () => {
  const bad: unknown[] = [
    { "/a": { icon: "data:image/svg+xml;base64,PHN2Zz4=" } },
    { "/a": { icon: "data:image/png;base64,AAAA" + "A".repeat(32_000) } },
    { "/a": { name: "x".repeat(61) } },
    { "/a": { name: "   " } },
    { "/a": { name: "a\nb" } },
    { "/a": { icon: "a b" } },
    { "/a": { icon: "x".repeat(17) } },
    { "/a": { name: "ok", extra: 1 } },
    { "/a": {} },
    { "": { name: "ok" } },
    Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`/p${i}`, { name: "n" }])),
    [],
  ];
  const s = createSettings({ file: file() });
  for (const projects of bad) expect(() => s.set({ labels: { projects } as never })).toThrow(/Project names and icons must be/);
  expect(() => s.set({ labels: { sides: { local: { name: 1 } } } as never })).toThrow(/Machine names and icons must be/);
});

it("labels: a __proto__ key does not leak into other objects", () => {
  const f = file();
  writeFileSync(f, '{"labels":{"projects":{"__proto__":{"name":"x"}}}}');
  const s = createSettings({ file: f });
  expect(({} as Record<string, unknown>).name).toBeUndefined();
  expect(Object.keys(s.get().labels.projects)).toEqual(["__proto__"]);
  expect(({} as Record<string, unknown>).name).toBeUndefined();
});

it("labels: a hand-edited invalid map falls back to {}", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ labels: { projects: { "/a": { name: 5 } }, sides: { local: { name: "Mac" } } } }));
  expect(createSettings({ file: f }).get().labels).toEqual({ projects: {}, sides: { local: { name: "Mac" } } });
});

it("closeFinished defaults to on, saves off, refuses a non-boolean with 'Close finished workers must be on or off'", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().orchestration.closeFinished).toBe(true);
  expect(s.set({ orchestration: { closeFinished: false } }).orchestration.closeFinished).toBe(false);
  expect(createSettings({ file: f }).get().orchestration.closeFinished).toBe(false);
  for (const bad of ["off", 0, null]) expect(() => s.set({ orchestration: { closeFinished: bad as never } })).toThrow(/^Close finished workers must be on or off$/);
});

it("stallMinutes defaults to 20 and accepts 0 to 240 only", () => {
  const s = createSettings({ file: file() });
  expect(s.get().orchestration.stallMinutes).toBe(20);
  for (const stallMinutes of [-1, 241, 1.5]) expect(() => s.set({ orchestration: { stallMinutes } as never })).toThrow("Stall alert after (minutes) must be a whole number from 0 to 240");
  for (const stallMinutes of [0, 240]) expect(s.set({ orchestration: { stallMinutes } }).orchestration.stallMinutes).toBe(stallMinutes);
});

it("keepWarmMinutes defaults to 55 and accepts 0 to 59 only", () => {
  const s = createSettings({ file: file() });
  expect(s.get().orchestration.keepWarmMinutes).toBe(55);
  for (const keepWarmMinutes of [-1, 60, 1.5]) expect(() => s.set({ orchestration: { keepWarmMinutes } as never })).toThrow("Keep coordinator cache warm (minutes) must be a whole number from 0 to 59");
  for (const keepWarmMinutes of [0, 59]) expect(s.set({ orchestration: { keepWarmMinutes } }).orchestration.keepWarmMinutes).toBe(keepWarmMinutes);
});

it("app icon: accepts the built-in icon, an emoji and a small raster data URL; stored and reset", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.get().app).toEqual({ icon: "", name: "" });
  for (const icon of ["🚀", "data:image/webp;base64,UklGRg==", PNG]) expect(s.set({ app: { icon } }).app.icon).toBe(icon);
  expect(createSettings({ file: f }).get().app.icon).toBe(PNG);
  s.set({ app: { icon: "" } });
  expect(JSON.parse(readFileSync(f, "utf8")).app?.icon).toBeUndefined();
});

it("app icon: refuses a too big image, another mime, a whitespace or long emoji and a non-string", () => {
  const s = createSettings({ file: file() });
  const bad = ["data:image/png;base64," + "A".repeat(300_000), "data:image/svg+xml;base64,PHN2Zz4=", "data:image/gif;base64,R0lGOD==", " ", "a b", "x".repeat(17), 5];
  for (const icon of bad) expect(() => s.set({ app: { icon: icon as never } })).toThrow(/App icon must be/);
});

it("app name: accepts the default and a label name; stored and reset", () => {
  const f = file();
  const s = createSettings({ file: f });
  for (const name of ["Work", "x".repeat(60), " Spaced ", ""]) expect(s.set({ app: { name } }).app.name).toBe(name);
  s.set({ app: { name: "Home" } });
  expect(createSettings({ file: f }).get().app).toEqual({ icon: "", name: "Home" });
});

it("app name: refuses only whitespace, a control character, a too long name and a non-string", () => {
  const s = createSettings({ file: file() });
  for (const name of [" ", "a\tb", "a\nb", "x".repeat(61), 5]) expect(() => s.set({ app: { name: name as never } })).toThrow(/App name must be/);
});

it("launcher defaults and validation", () => {
  expect(parseSettings({}).launcher).toEqual(DEFAULTS.launcher);
  for (const port of [0, 70000]) expect(checkPatch({ launcher: { port } })).toBe("Port must be a whole number from 1 to 65535");
  expect(checkPatch({ launcher: { roots: ["rel/dir"] } })).toMatch(/^Roots must be/);
  expect(checkPatch({ launcher: { roots: [resolve("x")] } })).toBeUndefined();
});

it("commit message instructions: saved, read back, the default is not stored; bad values are refused", () => {
  const f = file();
  const s = createSettings({ file: f });
  expect(s.set({ git: { commitMessageInstruction: "Short.", commitMessageInstructions: { "/p": "Mine" } } }).git).toMatchObject({ commitMessageInstruction: "Short.", commitMessageInstructions: { "/p": "Mine" } });
  expect(createSettings({ file: f }).get().git.commitMessageInstructions).toEqual({ "/p": "Mine" });
  s.set({ git: { commitMessageInstruction: "", commitMessageInstructions: {} } });
  expect(JSON.parse(readFileSync(f, "utf8")).git ?? {}).toEqual({});
  expect(s.set({ git: { commitMessageInstruction: "x".repeat(4000) } }).git.commitMessageInstruction).toHaveLength(4000);
  for (const v of ["x".repeat(4001), "a\0b", 5]) expect(() => s.set({ git: { commitMessageInstruction: v as never } })).toThrow(/Commit message instruction must be/);
  const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`/p${i}`, "x"]));
  for (const m of [many, { "/p": "" }, { "/p": "x".repeat(4001) }, { "": "x" }, { "/p": "a\0" }, [] as never]) expect(() => s.set({ git: { commitMessageInstructions: m } })).toThrow(/Commit message instructions per project must be/);
});

it("history: enabled is a boolean, exclude a list of globs", () => {
  expect(checkPatch({ history: { enabled: false, exclude: ["**/dist/**"] } })).toBeUndefined();
  expect(checkPatch({ history: { enabled: "yes" } })).toMatch(/Local history must be/);
  expect(checkPatch({ history: { exclude: [""] } })).toMatch(/excluded paths must be/);
});

it("editor: defaults empty; accepts a command and a name; refuses newline, NUL, unbalanced quote, empty program, over 1024 (GH-646)", () => {
  const s = createSettings({ file: join(mkdtempSync(join(tmpdir(), "set-")), "s.json") });
  expect(s.get().editor).toEqual({ command: "", name: "" });
  expect(s.set({ editor: { command: '"C:\\Program Files\\S\\subl.exe" {path}', name: "Sublime" } }).editor).toEqual({ command: '"C:\\Program Files\\S\\subl.exe" {path}', name: "Sublime" });
  for (const command of ["a\nb", "a\rb", "a\0b", 'a "b', '""', "   ", "x".repeat(1025)]) expect(() => s.set({ editor: { command } })).toThrow(/^Editor command must be/);
  expect(() => s.set({ editor: { name: "a\nb" } })).toThrow(/^Editor name must be/);
  expect(s.set({ editor: { command: "" } }).editor.command).toBe("");
});

it("chat.visualize defaults to on (also for a settings.json without chat), saves, refuses a non-boolean", () => {
  const f = file();
  writeFileSync(f, JSON.stringify({ chrome: { enabled: true } }));
  const s = createSettings({ file: f });
  expect(s.get().chat).toEqual({ visualize: true });
  expect(s.set({ chat: { visualize: false } }).chat).toEqual({ visualize: false });
  expect(() => s.set({ chat: { visualize: "yes" as never } })).toThrow("Inline visualizations must be on or off");
});

it("terminalAccess.enabled defaults to on, saves, refuses a non-boolean (GH-709)", () => {
  const s = createSettings({ file: file() });
  expect(s.get().terminalAccess).toEqual({ enabled: true });
  expect(s.set({ terminalAccess: { enabled: false } }).terminalAccess).toEqual({ enabled: false });
  expect(() => s.set({ terminalAccess: { enabled: 1 as never } })).toThrow("Let sessions use open terminals must be on or off");
});

it("inlineTask defaults, saves and refuses bad values (GH-734)", () => {
  const s = createSettings({ file: file() });
  expect(s.get().inlineTask).toEqual({ enabled: true, model: "haiku", openCodeModel: "", maxTurns: 10 });
  expect(s.set({ inlineTask: { maxTurns: 20, model: "sonnet", openCodeModel: "deepseek/flash" } }).inlineTask).toEqual({ enabled: true, model: "sonnet", openCodeModel: "deepseek/flash", maxTurns: 20 });
  expect(() => s.set({ inlineTask: { maxTurns: 0 } })).toThrow("Inline task maximum turns must be a whole number from 1 to 30");
  expect(() => s.set({ inlineTask: { maxTurns: 31 } })).toThrow("from 1 to 30");
  expect(() => s.set({ inlineTask: { model: "" } })).toThrow("Inline task model must be");
  expect(() => s.set({ inlineTask: { openCodeModel: "nomodel" } })).toThrow("Inline task OpenCode model must be");
  expect(() => s.set({ inlineTask: { enabled: 1 as never } })).toThrow("Inline tasks must be on or off");
});

it("fork.enabled defaults to on, saves, refuses a non-boolean (GH-718)", () => {
  const s = createSettings({ file: file() });
  expect(s.get().fork).toEqual({ enabled: true });
  expect(s.set({ fork: { enabled: false } }).fork).toEqual({ enabled: false });
  expect(() => s.set({ fork: { enabled: 1 as never } })).toThrow("Fork subagents must be on or off");
});
