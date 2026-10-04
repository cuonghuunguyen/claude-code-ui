// Bundles the daemon + protocol into dist/cli.js and copies the web build to dist/web (the daemon finds it next to itself).
import { build } from "esbuild";
import { chmodSync, cpSync, copyFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
rmSync(at("../dist"), { recursive: true, force: true });
await build({
  entryPoints: [at("../../daemon/src/main.ts")],
  outfile: at("../dist/cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Native or platform-specific packages stay runtime dependencies.
  external: Object.keys(pkg.dependencies),
  banner: { js: "#!/usr/bin/env node" },
});
chmodSync(at("../dist/cli.js"), 0o755);
cpSync(at("../../web/dist"), at("../dist/web"), { recursive: true });
copyFileSync(at("../../../THIRD_PARTY_NOTICES.md"), at("../THIRD_PARTY_NOTICES.md"));
