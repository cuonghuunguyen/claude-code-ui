import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { VISUALIZE_CSP, VISUALIZE_SHELL, visualizePluginDir } from "../src/visualize.ts";

it("the CSP is exactly the documented policy", () => {
  expect(VISUALIZE_CSP).toBe(
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
});

it("the plugin folder is found in the source checkout", () => {
  expect(existsSync(join(visualizePluginDir()!, "skills/visualize/SKILL.md"))).toBe(true);
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
