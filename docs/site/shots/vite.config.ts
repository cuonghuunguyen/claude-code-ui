// Docs screenshots (npm run docs:shots): the real app against a scripted fake daemon (scenes/README via CONTRIBUTING.md "Docs").
// Same plugins and alias as vite.config.ts; the only difference is that src/client.ts resolves to scenes/fake-client.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url)).replaceAll("\\", "/");
const realClient = here("./src/client.ts");
const fakeClient = here("./scenes/fake-client.ts");
const appVersion: string = JSON.parse(readFileSync(here("../claude-ui/package.json"), "utf8")).version ?? "dev";

/** Redirects every import of src/client.ts to the fake; the fake itself still reaches the real module for its types and helpers. */
function fakeDaemon(): Plugin {
  return {
    name: "scenes-fake-daemon",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!/client\.ts$/.test(source) || importer?.replaceAll("\\", "/") === fakeClient) return;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (r?.id.replaceAll("\\", "/") === realClient) return fakeClient;
    },
  };
}

export default defineConfig({
  root: here("./"),
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [fakeDaemon(), react(), tailwindcss()],
  resolve: { alias: { "@": here("./src") } },
  server: { host: "127.0.0.1" },
  logLevel: "warn",
});
