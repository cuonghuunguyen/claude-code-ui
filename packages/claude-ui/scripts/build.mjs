// Bundles the daemon + protocol into dist/cli.js, the `claude-ui` launcher into dist/launcher.js, and copies the web build to dist/web (the daemon finds it next to itself).
// dist/side/: the Docker side bundle's JS (docs/spec.md "Sides").
import { build } from "esbuild";
import { chmodSync, cpSync, copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(at("../dist"), { recursive: true, force: true });
await build({
  entryPoints: { cli: at("../../daemon/src/main.ts"), launcher: at("../../daemon/src/launcher-main.ts") },
  outdir: at("../dist"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Native or platform-specific packages stay runtime dependencies.
  external: Object.keys(pkg.dependencies),
  banner: { js: "#!/usr/bin/env node" },
});
// The side JS of the Docker bundle: everything but node-pty (native) and the Agent SDK (Anthropic's terms: the hub fetches it
// from the npm registry like the Claude Code binary, never re-hosted here) is inlined. Their license texts go next to it.
const side = await build({
  entryPoints: { cli: at("../../daemon/src/main.ts") },
  outdir: at("../dist/side"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // bufferutil and utf-8-validate are optional to ws.
  external: ["node-pty", "@anthropic-ai/claude-agent-sdk", "bufferutil", "utf-8-validate"],
  // Inlined CommonJS packages call require() for Node built-ins.
  banner: { js: "import { createRequire as __cuiRequire } from 'node:module'; const require = __cuiRequire(import.meta.url);" },
  metafile: true,
  logLevel: "warning",
});
const roots = new Set();
for (const id of Object.keys(side.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.replaceAll("\\", "/"));
  if (m) roots.add(resolve(m[1]));
}
const sections = [...roots].sort().map((root) => {
  const p = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const texts = readdirSync(root).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f)).map((f) => readFileSync(join(root, f), "utf8").trim());
  return `${p.name} ${p.version} (${p.license ?? "see text"})${p.license === "MPL-2.0" ? `\nSource Code Form: the npm package ${p.name}@${p.version} (https://www.npmjs.com/package/${p.name}), inlined unmodified.` : ""}\n\n${texts.join("\n\n") || "No license file shipped."}`;
});
writeFileSync(at("../dist/side/THIRD_PARTY_LICENSES.txt"), `Packages inlined in cli.js\n\n${sections.join(`\n\n${"-".repeat(80)}\n\n`)}\n`);
// The SDK version the side JS was built with: the hub fetches this version of the SDK and its Claude Code binary for the bundle.
const sdkDir = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
writeFileSync(at("../dist/side/side.json"), JSON.stringify({ sdk: JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version }));
for (const f of ["cli.js", "launcher.js"]) chmodSync(at(`../dist/${f}`), 0o755);
cpSync(at("../../web/dist"), at("../dist/web"), { recursive: true });
for (const f of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(at(`../../../${f}`), at(`../${f}`));
