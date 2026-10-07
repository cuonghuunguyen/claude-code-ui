// Bundles the daemon + protocol into dist/cli.js, the `claude-ui` launcher into dist/launcher.js, and copies the web build to dist/web (the daemon finds it next to itself).
import { build } from "esbuild";
import { chmodSync, cpSync, copyFileSync, rmSync } from "node:fs";
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
for (const f of ["cli.js", "launcher.js"]) chmodSync(at(`../dist/${f}`), 0o755);
cpSync(at("../../web/dist"), at("../dist/web"), { recursive: true });
for (const f of ["README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(at(`../../../${f}`), at(`../${f}`));
