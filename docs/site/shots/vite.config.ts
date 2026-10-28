// Docs screenshots (npm run docs:shots): the web app's own Vite config (plugins, alias, define) with the shots folder as root, plus one
// plugin that redirects every import of packages/web/src/client.ts to the fake daemon (packages/web/src/fake-client.ts).
import { fileURLToPath } from "node:url";
import { mergeConfig, type Plugin } from "vite";
import web from "../../../packages/web/vite.config.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url)).replaceAll("\\", "/");
const realClient = here("../../../packages/web/src/client.ts");
const fakeClient = here("../../../packages/web/src/fake-client.ts");

/** The fake itself still reaches the real module for its types and helpers. */
function fakeDaemon(): Plugin {
  return {
    name: "shots-fake-daemon",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!/client\.ts$/.test(source) || importer?.replaceAll("\\", "/") === fakeClient) return;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (r?.id.replaceAll("\\", "/") === realClient) return fakeClient;
    },
  };
}

export default mergeConfig(web, { root: here("./"), publicDir: here("../../../packages/web/public"), plugins: [fakeDaemon()], logLevel: "warn" });
