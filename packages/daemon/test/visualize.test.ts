import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { VISUALIZE_CSP, VISUALIZE_SHELL, visualizePluginDir, visualizeSystem } from "../src/visualize.ts";

it("the CSP is exactly the documented policy", () => {
  expect(VISUALIZE_CSP).toBe(
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
});

it("the plugin folder is found in the source checkout", () => {
  expect(existsSync(join(visualizePluginDir()!, "skills/visualize/SKILL.md"))).toBe(true);
});

it("a side install finds the plugin next to its cli.js", () => {
  const dist = join(mkdtempSync(join(tmpdir(), "viz-")), "node_modules/claude-code-ui/dist");
  mkdirSync(join(dist, "plugins/visualize/skills/visualize"), { recursive: true });
  writeFileSync(join(dist, "cli.js"), "");
  expect(visualizePluginDir(pathToFileURL(join(dist, "cli.js")).href)).toBe(join(dist, "plugins/visualize"));
});

// A fixture skill: the shipped wording is the skill author's to change, the parsing is ours.
const pluginWith = (skill: string | undefined): string => {
  const dir = mkdtempSync(join(tmpdir(), "viz-skill-"));
  if (skill !== undefined) {
    mkdirSync(join(dir, "skills/visualize"), { recursive: true });
    writeFileSync(join(dir, "skills/visualize/SKILL.md"), skill);
  }
  return dir;
};

it("visualizeSystem is the description, a blank line and the body, without frontmatter", () => {
  expect(visualizeSystem(pluginWith("---\nname: visualize\ndescription: WHEN-TEXT\n---\n\nBODY-TEXT\n"))).toBe("WHEN-TEXT\n\nBODY-TEXT");
});

it("visualizeSystem reads a CRLF skill file (a Windows checkout with autocrlf)", () => {
  expect(visualizeSystem(pluginWith("---\r\nname: visualize\r\ndescription: WHEN-TEXT\r\n---\r\nBODY-TEXT\r\n"))).toBe("WHEN-TEXT\n\nBODY-TEXT");
});

it("visualizeSystem is undefined without a description, a frontmatter, a file, a folder or a dir", () => {
  expect(visualizeSystem(pluginWith("---\nname: visualize\n---\nBODY-TEXT\n"))).toBeUndefined();
  expect(visualizeSystem(pluginWith("BODY-TEXT\n"))).toBeUndefined();
  expect(visualizeSystem(pluginWith(undefined))).toBeUndefined();
  expect(visualizeSystem(undefined)).toBeUndefined();
  expect(visualizeSystem(join(tmpdir(), "no-such-plugin"))).toBeUndefined();
});

it("the shipped skill has a description and yields a non-empty system text", () => {
  const dir = visualizePluginDir()!;
  expect(readFileSync(join(dir, "skills/visualize/SKILL.md"), "utf8")).toMatch(/^description:\s*\S/m);
  expect(visualizeSystem(dir)).toEqual(expect.stringMatching(/\S/));
});

it("the shell script is valid and renders only a render message from the parent", () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(VISUALIZE_SHELL)![1]!;
  const written: string[] = [];
  const handlers: ((e: unknown) => void)[] = [];
  const posted: unknown[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  new Function("parent", "addEventListener", "document", script)(parent, (_: string, h: (e: unknown) => void) => handlers.push(h), { open() {}, write: (s: string) => written.push(s), close() {} });
  expect(posted).toEqual([{ v: 1, type: "ready" }]);
  const send = (source: unknown, data: unknown) => handlers[0]!({ source, data });
  send({}, { v: 1, type: "render", html: "<p>no</p>" }); // not the parent
  send(parent, { v: 2, type: "render", html: "<p>no</p>" });
  expect(written).toEqual([]);
  send(parent, { v: 1, type: "render", html: "<p>yes</p>", vars: { "--background": "#fff", "--bad": "red;}</style>", "x y": "1" } });
  expect(written).toHaveLength(1);
  expect(written[0]).toContain("--background:#fff;");
  expect(written[0]).not.toContain("--bad");
  expect(written[0]).not.toContain("x y");
  expect(written[0]!.endsWith("<p>yes</p>")).toBe(true);
  send(parent, { v: 1, type: "render", html: "<p>again</p>" }); // once only
  expect(written).toHaveLength(1);
});

it("the written prefix paints the page with the host colours and color-scheme before the fence HTML", () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(VISUALIZE_SHELL)![1]!;
  const written: string[] = [];
  const handlers: ((e: unknown) => void)[] = [];
  const parent = { postMessage() {} };
  new Function("parent", "addEventListener", "document", script)(parent, (_: string, h: (e: unknown) => void) => handlers.push(h), { open() {}, write: (s: string) => written.push(s), close() {} });
  handlers[0]!({ source: parent, data: { v: 1, type: "render", html: "<p>x</p>", vars: { "--background": "#111", "--scheme": "dark" } } });
  const doc = written[0]!;
  expect(doc).toContain(":root{--background:#111;--scheme:dark;}");
  expect(doc).toContain("html{color-scheme:var(--scheme,light)}");
  expect(doc).toContain("html,body{margin:0;background:var(--background);color:var(--foreground);");
  expect(doc).not.toContain("background:transparent");
  expect(doc.indexOf("<style>")).toBeLessThan(doc.indexOf("<p>x</p>"));
  // The theme listener of the written document sets the same variables, --scheme included, and refuses unsafe ones.
  const inner = /<script>([\s\S]*)<\/script>/.exec(doc)![1]!;
  const style: Record<string, string> = {};
  const listeners: ((e: unknown) => void)[] = [];
  const p2 = { postMessage() {} };
  new Function("parent", "addEventListener", "document", "ResizeObserver", inner)(p2, (t: string, h: (e: unknown) => void) => t === "message" && listeners.push(h), { documentElement: { scrollHeight: 0, getBoundingClientRect: () => ({ height: 0 }), style: { setProperty: (k: string, v: string) => (style[k] = v) } } }, class { observe() {} });
  listeners[0]!({ source: p2, data: { v: 1, type: "theme", vars: { "--background": "#fff", "--scheme": "light", "--bad": "a;b" } } });
  expect(style).toEqual({ "--background": "#fff", "--scheme": "light" });
  // Height is the root box: scrollHeight never falls below the frame height, so the frame could not shrink.
  let sent: unknown;
  const content = { height: 50 };
  const shrink = new Function("parent", "addEventListener", "document", "ResizeObserver", inner);
  shrink({ postMessage: (m: unknown) => (sent = m) }, (t: string, h: () => void) => t === "load" && h(), { documentElement: { scrollHeight: 432, getBoundingClientRect: () => content, style: {} } }, class { observe() {} });
  expect(sent).toEqual({ v: 1, type: "height", height: 50 });
});

it("the plugin's SessionStart hook hands the model the same text as OpenCode's system, except on resume and fork", () => {
  const hook = (source: string) => execFileSync(process.execPath, [join(visualizePluginDir()!, "hooks/session-start.mjs")], { input: JSON.stringify({ source }), encoding: "utf8" });
  for (const source of ["startup", "clear", "compact"])
    expect(JSON.parse(hook(source))).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: visualizeSystem(visualizePluginDir()) } });
  for (const source of ["resume", "fork"]) expect(hook(source)).toBe("");
});
