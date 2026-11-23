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

export function createFolderReloads(o: { reload(cwd: string): Promise<boolean>; changed(kind: ConfigKind, cwd: string): void; retryMs?: number; settledRetryMs?: number }): FolderReloads {
  const waiting = new Map<string, Set<ConfigKind>>();
  const running = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let again: NodeJS.Timeout | undefined;

  /** A reload that worked also applies what earlier requests of the folder waited for: their dialogs are told. */
  const done = (cwd: string) => {
    const kinds = waiting.get(cwd);
    waiting.delete(cwd);
    if (!waiting.size && timer) (clearInterval(timer), (timer = undefined));
    for (const k of kinds ?? []) o.changed(k, cwd);
  };
  const retry = async () => {
    for (const cwd of [...waiting.keys()]) {
      if (running.has(cwd)) continue;
      running.add(cwd);
      try {
        if (await o.reload(cwd)) done(cwd);
      } finally {
        running.delete(cwd);
      }
    }
  };
  const arm = () => {
    if (timer) return;
    timer = setInterval(() => void retry(), o.retryMs ?? RETRY_MS);
    timer.unref();
  };

  return {
    async request(cwd, kinds) {
      running.add(cwd);
      let ok = false;
      try {
        ok = await o.reload(cwd);
      } finally {
        running.delete(cwd);
      }
      if (ok) {
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
