// GH-1016: with `launch_handler: focus-existing` a `claude-ui open` focuses the open app window and hands it the launch URL here
// (no reload). A new fragment (`#token=…` pairing, `#<sessionId>` deep link) is applied by changing the hash: the existing
// `hashchange` handlers reload for a token and route a session.

export type LaunchParams = { targetURL?: string };
export type LaunchQueue = { setConsumer: (fn: (p: LaunchParams) => void) => void };

/** Applies the fragment of a same-origin launch URL; returns whether the hash changed. */
export function applyLaunch(p: LaunchParams, loc: Pick<Location, "origin" | "hash"> = location): boolean {
  let u: URL;
  try {
    u = new URL(p.targetURL ?? "");
  } catch {
    return false;
  }
  if (u.origin !== loc.origin || !u.hash || u.hash === loc.hash) return false;
  loc.hash = u.hash;
  return true;
}

export const consumeLaunches = (q: LaunchQueue | undefined = (globalThis as { launchQueue?: LaunchQueue }).launchQueue) => q?.setConsumer((p) => void applyLaunch(p));
