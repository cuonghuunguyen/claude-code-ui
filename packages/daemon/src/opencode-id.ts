// OpenCode message and part ids: `<prefix>_` + 12 hex (6 bytes of ms * 0x1000 + counter) + 14 base62 random characters, so ids sort by time.
// The format follows OpenCode's `Identifier.ascending` (id.ts, MIT license); a message id we choose must sort after the messages before it.
import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastMs = 0;
let counter = 0;

export function ascending(prefix: "msg" | "prt"): string {
  const ms = Date.now();
  if (ms !== lastMs) (lastMs = ms), (counter = 0);
  counter++;
  const time = (BigInt(ms) * 0x1000n + BigInt(counter)).toString(16).padStart(12, "0").slice(-12);
  const random = Array.from(randomBytes(14), (b) => BASE62[b % 62]).join("");
  return `${prefix}_${time}${random}`;
}
