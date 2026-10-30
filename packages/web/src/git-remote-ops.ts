// Remote operations of the Graph (docs/spec.md "Layout", Graph tab), per repository path: they outlive a GraphPanel remount (repository switch).
import { useSyncExternalStore } from "react";
import type { GitRemoteResult } from "@claude-ui/protocol";
import type { connect, RequestError } from "./client.ts";
import type { RemoteRequest } from "./git-branch-menu.tsx";
import { t } from "./i18n.ts";
import { noteRefs } from "./git-refs.ts";

type Client = ReturnType<typeof connect>;
export type RemoteResultLine = { ok: boolean; text: string; output?: string };
/** `running`: the live text while an op runs; `result`: the last op's line; `settled`: bumps when an op ends (the mounted panel reloads fresh). */
export type RemoteOpState = { running?: string; result?: RemoteResultLine; settled: number };
const EMPTY: RemoteOpState = { settled: 0 };
const ops = new Map<string, RemoteOpState>();
const subs = new Set<() => void>();
/** The state of one repository; the same object until it changes (a stable snapshot for `useSyncExternalStore`). */
export const remoteOpOf = (path: string): RemoteOpState => ops.get(path) ?? EMPTY;
const get = remoteOpOf;
const set = (path: string, next: RemoteOpState) => {
  ops.set(path, next);
  for (const s of [...subs]) s();
};

/** Starts `msg` on its repository (`msg.cwd`). False, sending nothing, while one already runs there. Success or failure, `settled` bumps: a failed `fetch --all` may still have updated some remotes. */
export function runRemoteOp(client: Client, msg: RemoteRequest, done: string, running: string): boolean {
  const at = msg.cwd;
  if (get(at).running !== undefined) return false;
  set(at, { ...get(at), running, result: undefined });
  const end = (result: RemoteResultLine) => set(at, { running: undefined, result, settled: get(at).settled + 1 });
  client.request<GitRemoteResult>(msg).then(
    (r) => {
      noteRefs(at, r.remote?.refs ?? undefined);
      end({ ok: true, text: done, output: r.remote?.output || undefined });
    },
    (e: RequestError) => end({ ok: false, text: e.message || t("files.gitFailed") }),
  );
  return true;
}

export function dismissRemoteResult(path: string): void {
  if (get(path).result) set(path, { ...get(path), result: undefined });
}

const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => void subs.delete(cb);
};
export const useRemoteOp = (path: string): RemoteOpState => useSyncExternalStore(subscribe, () => get(path));

/** Tests: forgets every repository's op. */
export const forgetRemoteOps = (): void => ops.clear();
