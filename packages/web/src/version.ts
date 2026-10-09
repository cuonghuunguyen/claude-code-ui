// The claude-code-ui version this bundle was built from (vite `define` in vite.config.ts); "dev" where nothing defines it (tests, tooling).
declare const __APP_VERSION__: string | undefined;
export const WEB_VERSION: string = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "dev";
