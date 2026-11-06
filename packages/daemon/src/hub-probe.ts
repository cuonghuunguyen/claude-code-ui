// GH-619: find the live Hub of a machine (its daemon.json) so an attaching Hub bridges through that Hub's own cli: no install of this build.
import { schemaOverlap, SIDE_SCHEMA } from "./side-frame.ts";

/**
 * POSIX sh: prints `CLAUDE_UI_CHECK hub=<base64 of daemon.json>` when that file exists and its pid is alive. The pid is digits only (sed), so it is safe to pass on.
 * The path is `configDir()` on Linux and macOS (`XDG_CONFIG_HOME` or `~/.config`). daemon.json holds no token.
 */
export const HUB_PROBE = `f="\${XDG_CONFIG_HOME:-$HOME/.config}/claude-ui/daemon.json"
p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$f" 2>/dev/null)
[ -n "$p" ] && kill -0 "$p" 2>/dev/null && printf 'CLAUDE_UI_CHECK hub=%s\\n' "$(base64 < "$f" | tr -d '\\n')"`;

export type Hub = { exec: string[]; version: string };

/** A live Hub of this machine that this build can bridge through; undefined otherwise. The output comes from another machine: validated, never trusted. */
export function parseHub(stdout: string): Hub | undefined {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("CLAUDE_UI_CHECK hub="));
  if (!line) return undefined;
  try {
    const v = JSON.parse(Buffer.from(line.slice("CLAUDE_UI_CHECK hub=".length), "base64").toString("utf8"));
    const { attach, schema, exec, version } = v ?? {};
    const ok =
      typeof attach === "string" && attach !== "" &&
      Array.isArray(schema) && schema.length === 2 && schema.every(Number.isInteger) && schemaOverlap(schema as [number, number], SIDE_SCHEMA) &&
      Array.isArray(exec) && exec.length >= 1 && exec.length <= 32 && exec.every((e) => typeof e === "string" && e !== "") && exec[0].startsWith("/") &&
      typeof version === "string" && version !== "";
    return ok ? { exec, version: version.slice(0, 100) } : undefined;
  } catch {
    return undefined;
  }
}
