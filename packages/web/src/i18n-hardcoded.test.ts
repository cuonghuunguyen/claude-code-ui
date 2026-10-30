// Every user-visible string of a component comes from the catalog (i18n.ts). Fails on English written straight into JSX:
// text children, string literals rendered as children (also inside `a ? "x" : "y"` and `a && "x"`), and literal
// values of the attributes a person reads or hears (aria-label, title, placeholder, alt, label).
// shortcut: strings built in a helper and passed down are not seen here; the review catches those.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";
import { expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const ATTRS = new Set(["aria-label", "aria-description", "aria-valuetext", "aria-roledescription", "title", "placeholder", "alt", "label"]);
/** Not words of a language: product and protocol names, units, key names, symbols. */
const ALLOWED = new Set<string>(["claude-code-ui", "Claude", "Claude Code", "Git", "MCP", "Jira", "URL", "ID", "PID", "WSL", "Docker", "OK", "Esc", "Enter", "Tab", "Shift", "Ctrl", "Alt", "Cmd"]);
const word = /\p{L}{2,}/u;

type Node = { type?: string; start: number; [k: string]: unknown };

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "i18n" ? [] : components(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** String literals a JSX child or attribute expression renders as is. */
function rendered(e: Node | undefined): Node[] {
  if (!e) return [];
  if (e.type === "Literal" && typeof e.value === "string") return [e];
  if (e.type === "TemplateLiteral") return [e];
  if (e.type === "ConditionalExpression") return [...rendered(e.consequent as Node), ...rendered(e.alternate as Node)];
  if (e.type === "LogicalExpression") return rendered(e.right as Node);
  return [];
}
const text = (n: Node) => (n.type === "TemplateLiteral" ? (n.quasis as { value: { raw: string } }[]).map((q) => q.value.raw).join(" ") : String(n.value)).trim();

function hardcoded(file: string, source: string): string[] {
  const out: string[] = [];
  const line = (n: Node) => source.slice(0, n.start).split("\n").length;
  const flag = (n: Node, s: string) => word.test(s) && !ALLOWED.has(s) && out.push(`${file}:${line(n)}: ${s.slice(0, 70)}`);
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const node = n as Node;
    if (node.type === "JSXText") flag(node, String(node.value).trim());
    if (node.type === "JSXExpressionContainer" && (node as { parentIsChild?: boolean }).parentIsChild) for (const l of rendered(node.expression as Node)) flag(l, text(l));
    if (node.type === "JSXElement" || node.type === "JSXFragment")
      for (const c of node.children as Node[]) if (c.type === "JSXExpressionContainer") (c as { parentIsChild?: boolean }).parentIsChild = true;
    if (node.type === "JSXAttribute" && ATTRS.has(String((node.name as { name: unknown }).name))) {
      const v = node.value as Node | null;
      for (const l of v?.type === "JSXExpressionContainer" ? rendered(v.expression as Node) : v ? rendered(v) : []) flag(l, text(l));
    }
    for (const k in node) if (k !== "parentIsChild") visit(node[k]);
  };
  visit(parseSync(file, source, { lang: "tsx" }).program);
  return out;
}

it("finds hard-coded text in JSX", () => {
  const src = `const a = <div title="Close" aria-label={x ? "Open it" : t("k")}>Hello {busy ? "Saving…" : t("k")} {n && "items"} {"→"}</div>;`;
  expect(hardcoded("a.tsx", src).map((s) => s.split(": ")[1])).toEqual(["Close", "Open it", "Hello", "Saving…", "items"]);
});

it("no component writes user-visible English straight into JSX", () => {
  const hits = components(SRC).flatMap((f) => hardcoded(relative(SRC, f), readFileSync(f, "utf8")));
  expect(hits).toEqual([]);
});
