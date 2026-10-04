// Pairing token: generated on first run, kept owner-only in the config dir, presented on every WebSocket.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

/** $XDG_CONFIG_HOME/claude-ui or ~/.config/claude-ui; on Windows without XDG_CONFIG_HOME %APPDATA%\claude-ui, unless the old dir exists (its pairing and state stay). */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync) {
  const xdg = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "claude-ui");
  return platform === "win32" && env.APPDATA && !env.XDG_CONFIG_HOME && !exists(xdg) ? win32.join(env.APPDATA, "claude-ui") : xdg;
}

export function loadToken(dir = configDir()): string {
  const file = join(dir, "token");
  try {
    const token = readFileSync(file, "utf8").trim();
    // mode on writeFileSync applies only on creation; a copied file may be world-readable.
    if (token) {
      chmodSync(file, 0o600);
      return token;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

/** The token goes in the fragment: browsers never send it to the server, so it stays out of request lines. */
export const pairingUrl = (origin: string, token: string) => `${origin}/#token=${token}`;
