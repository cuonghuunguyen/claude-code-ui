import { join } from "node:path";
import { cacheHome, configHome } from "./paths.ts";

/**
 * OpenCode's own store of the run: keeps test sessions out of ~/.local/share/opencode. `port`: the env of a scenario daemon on that port,
 * which also writes its OpenCode server to its own info file (one per daemon: workers of a run each have theirs).
 */
export const opencodeEnv = (run: string, port?: number): NodeJS.ProcessEnv => ({
  XDG_DATA_HOME: join(run, "opencode-data"),
  XDG_STATE_HOME: join(run, "opencode-state"),
  XDG_CACHE_HOME: cacheHome(run),
  XDG_CONFIG_HOME: configHome(run),
  ...(port !== undefined && { CLAUDE_UI_E2E_OPENCODE_INFO: openCodeInfoFile(run, port) }),
});

/** Where the scenario daemon on `port` writes the url and auth of its OpenCode server (only when `CLAUDE_UI_E2E_OPENCODE_INFO` is set: `opencodeEnv`). */
export const openCodeInfoFile = (run: string, port: number) => join(run, `opencode-server-${port}.json`);
