// A user start on a machine whose Hub was started by another computer's attach (ADR 0009): the attach-started Hub is asked to retire (the same
// `update.install` + `update.restart` calls as `claude-ui update`), the start waits until it exits, then the user's Hub takes over and attached Hubs follow.
import { readDaemonFile } from "./daemon-file.ts";

/**
 * Returns at once when no live attach-started Hub is named in `<dir>/daemon.json` (a Hub the user started is never asked). Else asks it to retire, says
 * so while turns still run, and resolves when its pid is gone. A failed request is fine when the pid is gone meanwhile; else it rejects.
 */
export async function retireAttachHub(o: { dir: string; alive: (pid: number) => boolean; ask: (port: number, token: string) => Promise<{ installed: string; waitingFor: number }>; token: () => string; log: (line: string) => void; pollMs?: number }): Promise<void> {
  const d = readDaemonFile(o.dir);
  if (d?.startedBy !== "attach" || !o.alive(d.pid)) return;
  let waitingFor: number;
  try {
    waitingFor = (await o.ask(d.port, o.token())).waitingFor;
  } catch (e) {
    if (!o.alive(d.pid)) return;
    throw e;
  }
  if (waitingFor > 0) o.log(`claude-ui: a Claude UI started by another computer's attach runs here (pid ${d.pid}); waiting for its ${waitingFor} running turn(s) to finish.`);
  while (o.alive(d.pid)) await new Promise((r) => setTimeout(r, o.pollMs ?? 500));
}
