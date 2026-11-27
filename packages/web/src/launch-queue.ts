// GH-1016: with `launch_handler: focus-existing` a `claude-ui open` focuses the open app window and hands it the launch URL here
// (no reload). A new fragment (`#<sessionId>` deep link, `#token=…` pairing) is applied by changing the hash: main.tsx reloads
// for a token, App's hash/popstate handlers route a session. A token this browser already holds is ignored (no reload).

import { storedToken } from "./pairing.ts";

export type LaunchParams = { targetURL?: string };
export type LaunchQueue = { setConsumer: (fn: (p: LaunchParams) => void) => void };

/** Applies the fragment of a same-origin launch URL; returns whether the hash changed. */
export function applyLaunch(p: LaunchParams, loc: Pick<Location, "origin" | "hash"> = location, held: string | undefined = storedToken()): boolean {
  let u: URL;
  try {
    u = new URL(p.targetURL ?? "");
  } catch {
    return false;
  }
  if (u.origin !== loc.origin || !u.hash || u.hash === loc.hash) return false;
  // A plain `claude-ui open` always carries the pairing token: a window paired with it stays as it is.
  if (held && new URLSearchParams(u.hash.slice(1)).get("token") === held) return false;
  loc.hash = u.hash;
  return true;
}

export const consumeLaunches = (q: LaunchQueue | undefined = (globalThis as { launchQueue?: LaunchQueue }).launchQueue) => q?.setConsumer((p) => void applyLaunch(p));
