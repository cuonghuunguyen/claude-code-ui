import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightTree, tags } from "@lezer/highlight";
import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { ADJUST, adjustedTheme } from "./code-palette.ts";
import { loadLanguage, syntaxStyle } from "./code-theme.ts";

// GH-394: the editor (Lezer + syntaxStyle + --syntax-* in index.css) and the diff (Shiki + the adjusted pierre theme) are two engines
// on one palette. This test colours the same samples with both and compares them character by character.
const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
const block = (selector: string) => new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m").exec(css)![1]!;
const cssVars = (mode: "light" | "dark") => Object.fromEntries([...block(mode === "light" ? ":root" : ".dark").matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));

const SAMPLES: Record<string, { file: string; lang: string; code: string }> = {
  ts: {
    file: "a.ts",
    lang: "ts",
    code: `import { readFile } from "node:fs";\n// comment\nexport interface Opts { path: string; line?: number }\nconst MAX = 2 * 1024;\nlet n = 0, ok = true, none = null;\n@dec class Foo<T> extends Bar implements Baz {\n  private x = /a+b/g;\n  constructor(readonly p: Opts) { super(); this.x = \`v\${n}\n\`; }\n  async run(a: number): Promise<void> { if (a > MAX && !ok) return; console.log(a, Foo.name, undefined); }\n}\nfunction f(x = 1) { return typeof x === "number" ? x : -1; }\nexport default new Foo({ path: "a", line: 1 }).run(3);`,
  },
  tsx: { file: "a.tsx", lang: "tsx", code: `const A = () => <div className="x" onClick={go}>hi {name}</div>;` },
  json: { file: "a.json", lang: "json", code: `{ "name": "x", "n": 1.5, "ok": true, "z": null, "arr": ["a", 2] }` },
  markdown: {
    file: "a.md",
    lang: "markdown",
    code: "# Title\n\n> quote\n\nSome **bold** and _it_ and `code` [link](http://x) ![img](a.png)\n\n- item\n1. one\n\n```ts\nconst a = 1;\n```\n---\n| a | b |\n|---|---|\n",
  },
  css: {
    file: "a.css",
    lang: "css",
    code: `@media (width < 40rem) { .a > #b:hover::before, div[data-x="y"] { color: #fff; margin: 0 auto !important; --v: calc(1px + 2em); background: url(a.png) red; } }`,
  },
};

/** Tokens where Lezer cannot tell what Shiki's TextMate grammar can (a name's role, a regexp's inside, punctuation that is also an operator), so
 *  the editor keeps the neighbouring colour. The plan expected five (UPPER_CASE consts, `new Foo`, `undefined`, template backticks, `${ }`);
 *  the probe found the rest listed here. A gap is visible, not hidden: fixing one makes the stale-entry test below ask to delete it.
 *  Tokens are Shiki's (a run of one colour, so light and dark can cut them differently: the list is the union). */
const KNOWN_GAPS = new Set<string>([
  "css: #",
  "css: (a.png)",
  "css: (width",
  "css: .",
  "css: ::",
  "css: =",
  "css: >",
  "css: @",
  "css: a.png",
  "css: url",
  "markdown: (",
  "markdown: )",
  "markdown: a",
  "ts: ${",
  "ts: +",
  "ts: /",
  "ts: :",
  "ts: <",
  "ts: >",
  "ts: ?",
  "ts: Foo",
  "ts: MAX",
  "ts: `",
  "ts: constructor",
  "ts: g",
  "ts: run",
  "ts: undefined",
  "ts: void",
  "ts: }",
  "tsx: >hi",
  "tsx: A",
  "tsx: {",
  "tsx: }",
]);
const found: Record<"light" | "dark", Set<string>> = { light: new Set(), dark: new Set() };

const classColors = (mode: "light" | "dark") => {
  const vars = cssVars(mode);
  const rules = syntaxStyle.module!.getRules();
  // the stylesheet order decides when two classes colour one token: the rule defined last wins
  const byClass = new Map<string, { color: string; order: number }>();
  for (const m of rules.matchAll(/\.([\wͰ-Ͽ]+) \{([^}]*)\}/g)) {
    const c = /color: var\(--(syntax-[\w-]+)\)/.exec(m[2]!)?.[1];
    if (c) byClass.set(m[1]!, { color: vars[c]!, order: byClass.size });
  }
  return { byClass, fg: vars.foreground! };
};

async function lezerColors(file: string, code: string, mode: "light" | "dark") {
  await languages.find((l) => l.name === "TypeScript")!.load();
  const state = EditorState.create({ doc: code, extensions: await loadLanguage("/p/" + file)! });
  const { byClass, fg } = classColors(mode);
  const out = Array<string>(code.length).fill(fg);
  highlightTree(ensureSyntaxTree(state, code.length, 10000)!, syntaxStyle, (from, to, cls) => {
    const hit = cls.split(" ").map((c) => byClass.get(c)).filter((h) => !!h).sort((a, b) => b!.order - a!.order)[0];
    if (hit) out.fill(hit.color, from, to);
  });
  return out;
}

describe("palette parity: the editor colours the samples like the diff does", () => {
  const gaps = found;
  for (const mode of ["light", "dark"] as const) {
    it(`${mode}: every token Shiki colours has the same colour in the editor, except KNOWN_GAPS`, async () => {
      const h = await createHighlighter({ themes: [adjustedTheme(mode)], langs: ["ts", "tsx", "json", "markdown", "css"], engine: createJavaScriptRegexEngine() });
      for (const [name, s] of Object.entries(SAMPLES)) {
        const cm = await lezerColors(s.file, s.code, mode);
        let offset = 0;
        for (const line of h.codeToTokens(s.code, { lang: s.lang as never, theme: adjustedTheme(mode).name! }).tokens) {
          for (const tok of line) {
            const text = tok.content;
            const at = s.code.indexOf(text, offset);
            offset = at + text.length;
            if (!text.trim()) continue;
            const wrong = [...text].some((ch, i) => ch.trim() && cm[at + i] !== tok.color!.toLowerCase());
            if (wrong) gaps[mode].add(`${name}: ${text.trim()}`);
          }
        }
      }
      for (const g of gaps[mode]) expect(KNOWN_GAPS.has(g), `${mode}: ${g} is a new mismatch with the diff`).toBe(true);
    }, 60000);
  }
});

it("KNOWN_GAPS has no stale entry: each one still differs in light or dark", () => {
  for (const g of KNOWN_GAPS) expect(found.light.has(g) || found.dark.has(g), `${g} now matches: delete it from KNOWN_GAPS`).toBe(true);
});

it("markdown: headings, list marks and heading marks are --syntax-tag, quotes comment grey, other marks punctuation, emphasis keeps its font", async () => {
  const vars = cssVars("light");
  const colorOf = (tag: Parameters<typeof syntaxStyle.style>[0]) => {
    const cls = syntaxStyle.style(tag)!;
    return new RegExp(`\\.${cls} \\{[^}]*color: var\\(--(syntax-[\\w-]+)\\)`).exec(syntaxStyle.module!.getRules())?.[1];
  };
  expect(colorOf([tags.heading1])).toBe("syntax-tag");
  expect(colorOf([tags.quote])).toBe("syntax-comment");
  expect(colorOf([tags.processingInstruction])).toBe("syntax-punctuation");
  expect(colorOf([tags.strong])).toBe("syntax-constant");
  expect(vars["syntax-tag"]).toBeDefined();
  expect(syntaxStyle.module!.getRules()).toMatch(/font-weight: bold/);
  expect(syntaxStyle.module!.getRules()).toMatch(/font-style: italic/);
});

it("markdown: GFM header cells keep the text colour, the pipes are punctuation; a fenced block is a mounted TypeScript tree", async () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |\n";
  const state = EditorState.create({ doc: table, extensions: await loadLanguage("/p/README.md")! });
  const styled: string[] = [];
  highlightTree(ensureSyntaxTree(state, table.length, 5000)!, syntaxStyle, (from, to) => void styled.push(table.slice(from, to)));
  expect(styled.every((x) => /^[|\-]+$/.test(x))).toBe(true);
  expect(styled).toContain("|");
  await languages.find((l) => l.name === "Python")!.load();
  const md = "```python\ndef f():\n    return 1\n```\n";
  const mdState = EditorState.create({ doc: md, extensions: await loadLanguage("/p/README.md")! });
  expect(ensureSyntaxTree(mdState, md.length, 5000)!.resolveInner(md.indexOf("def") + 1, 1).name).toBe("def");
});

it("adjusted palette is what the editor reads: --syntax-keyword is the adjusted pierre keyword", () => {
  expect(cssVars("light")["syntax-keyword"]).toBe(ADJUST.light["#d32a61"]);
  expect(syntaxStyle.module!.getRules()).toContain("var(--syntax-keyword)");
});
