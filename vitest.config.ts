import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./packages/web/src", import.meta.url)) } },
  test: { include: ["packages/*/test/**/*.test.ts", "packages/*/src/**/*.test.{ts,tsx}"] },
});
