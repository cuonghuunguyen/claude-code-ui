// Reload of an engine's folder after a config change saved while a session of the folder was busy (docs/spec.md "Config dialogs"): a reload cancels running turns,
// so it waits for idle. The change stays pending per folder and is retried when a session of the engine ends a turn and every 30 s; once it ran, the dialogs of the
// folder are told with `config.changed` per kind, so their "applies when idle" text goes.
import type { ConfigKind } from "@claude-ui/protocol";

/** The retry timer of pending folders. */
const RETRY_MS = 30_000;
/** After a turn end the status of the folder may lag a moment: one more try follows. */
const SETTLED_RETRY_MS = 2_000;

export type FolderReloads = {
  /** Reloads `cwd` now. True: done. False: kept pending (busy or failed) until a retry succeeds, then `config.changed` is sent for `kinds`. */
  request(cwd: string, kinds: ConfigKind[]): Promise<boolean>;
  /** A session ended a turn: pending folders are tried again. */
  settled(): void;
  pending(cwd: string): boolean;
  close(): void;
};

export function createFolderReloads(o: {
  /** One reload applies to every folder (OpenCode 2 reloads every location): `reload` gets the folders to wait for, and all pending folders are done with it. */
  all?: boolean;
  reload(cwd: string, folders: string[]): Promise<boolean>;   changed(kind: ConfigKind, cwd: string): void;
  retryMs?: number;
  settledRetryMs?: number;
}): FolderReloads {
  const waiting = new Map<string, Set<ConfigKind>>();
  /** The reload of each folder in flight: a second one of the same folder runs after it (its change may be newer than what the first read). */
  const running = new Map<string, Promise<boolean>>();
  let timer: NodeJS.Timeout | undefined;
  let again: NodeJS.Timeout | undefined;

  const run = (cwd: string): Promise<boolean> => {
    const prev = running.get(cwd);
    const folders = o.all ? [...new Set([cwd, ...waiting.keys()])] : [cwd];
    const p = (prev ? prev.then(() => undefined, () => undefined).then(() => o.reload(cwd, folders)) : o.reload(cwd, folders)).finally(() => running.get(cwd) === p && running.delete(cwd));
    running.set(cwd, p);
    return p;
  };
  /** A reload that worked also applies what earlier requests of the folder waited for: their dialogs are told. With `all`, every waiting folder. */
  const done = (cwd: string) => {
    for (const f of o.all ? [...waiting.keys()] : [cwd]) {
      const kinds = waiting.get(f);
      waiting.delete(f);
      for (const k of kinds ?? []) o.changed(k, f);
    }
    if (!waiting.size && timer) (clearInterval(timer), (timer = undefined));
  };
  const retry = async () => {
    for (const cwd of [...waiting.keys()]) {
      if (running.has(cwd) || !waiting.has(cwd)) continue;
      if (await run(cwd)) done(cwd);
    }
  };
  const arm = () => {
    if (timer) return;
    timer = setInterval(() => void retry(), o.retryMs ?? RETRY_MS);
    timer.unref();
  };

  return {
    async request(cwd, kinds) {
      if (await run(cwd)) {
        // The caller's own kinds are answered by the reply; earlier ones are told.
        done(cwd);
        return true;
      }
      const set = waiting.get(cwd) ?? new Set<ConfigKind>();
      for (const k of kinds) set.add(k);
      waiting.set(cwd, set);
      arm();
      return false;
    },
    settled() {
      if (!waiting.size) return;
      void retry().then(() => {
        if (!waiting.size || again) return;
        again = setTimeout(() => ((again = undefined), void retry()), o.settledRetryMs ?? SETTLED_RETRY_MS);
        again.unref();
      });
    },
    pending: (cwd) => waiting.has(cwd),
    close() {
      if (timer) clearInterval(timer);
      if (again) clearTimeout(again);
      timer = again = undefined;
      waiting.clear();
    },
  };
}
