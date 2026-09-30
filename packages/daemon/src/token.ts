// Pairing token: generated on first run, kept owner-only in the config dir, presented on every WebSocket.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "claude-ui");

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
export const pairingUrl = (host: string, port: number, token: string) => `http://${host}:${port}/#token=${token}`;
