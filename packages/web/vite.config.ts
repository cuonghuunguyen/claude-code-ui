import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { assetsInlineLimit } from "./assets-inline.ts";
import { precompress } from "./precompress.ts";

/** Bundled packages' license and NOTICE texts into THIRD_PARTY_LICENSES.txt (MIT, Apache-2.0, OFL require them in copies). */
function thirdPartyLicenses(): Plugin {
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle(_, bundle) {
      const roots = new Set<string>();
      // Modules, plus files copied as assets (the Inter fonts come in through CSS @import, not a module).
      const assets = Object.values(bundle).flatMap((f) => (f.type === "asset" ? f.originalFileNames : []));
      for (const id of [...this.getModuleIds(), ...assets]) {
        const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(id.replaceAll("\\", "/"));
        if (m) roots.add(m[1]);
      }
      const sections = [...roots].sort().map((root) => {
        const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
        const texts = readdirSync(root).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f)).map((f) => readFileSync(`${root}/${f}`, "utf8").trim());
        return `${pkg.name} ${pkg.version} (${pkg.license ?? "see text"})\n\n${texts.join("\n\n") || "No license file shipped."}`;
      });
      this.emitFile({ type: "asset", fileName: "THIRD_PARTY_LICENSES.txt", source: sections.join(`\n\n${"-".repeat(80)}\n\n`) + "\n" });
    },
  };
}

/** Preload the Latin Inter subset: the CSS names it, so without this the browser starts it only after the entry chunk and the stylesheet are in. Build only (the hashed file name comes from the bundle). */
function preloadInter(): Plugin {
  return {
    name: "preload-inter",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find((n) => /(^|\/)inter-latin-wght-normal-[^/]*\.woff2$/.test(n));
        return file ? [{ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: `/${file}` }, injectTo: "head-prepend" as const }] : [];
      },
    },
  };
}

// The claude-code-ui package version, shown in Settings > About (`__APP_VERSION__`; "dev" where not defined).
const appVersion: string = JSON.parse(readFileSync(fileURLToPath(new URL("../claude-ui/package.json", import.meta.url)), "utf8")).version ?? "dev";

// Dev: `npm run dev` proxies /ws to the daemon on PORT (default 4280).
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), tailwindcss(), preloadInter(), thirdPartyLicenses(), precompress()],
  build: { assetsInlineLimit },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { host: "127.0.0.1", proxy: { "/media": { target: `http://127.0.0.1:${process.env.PORT ?? 4280}` }, "/app-icon": { target: `http://127.0.0.1:${process.env.PORT ?? 4280}` }, "/ws": { target: `ws://127.0.0.1:${process.env.PORT ?? 4280}`, ws: true } } },
});
