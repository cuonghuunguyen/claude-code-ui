// The commit message generator settings (GH-984) in one module store, so the commit box reads them without props (the same way as labels.ts):
// the global `git.commitMessage*` keys and the Project overrides. The daemon decides the real engine; this is only the box's hint.
import { useSyncExternalStore } from "react";
import { LOCAL_SIDE, type Engine, type Settings } from "@claude-ui/protocol";

export type CommitGenerator = { engine: Engine; model: string; openCodeModel: string };
type State = { global: CommitGenerator; overrides: Settings["projects"]["overrides"] };
const EMPTY: State = { global: { engine: "claude", model: "haiku", openCodeModel: "" }, overrides: {} };
let cur = EMPTY;
const subs = new Set<() => void>();

/** From settings.get and settings_changed; an older daemon has none of the keys (Claude on haiku, as before). */
export function setCommitGenerator(s: Settings) {
  const next: State = { global: { engine: s.git?.commitMessageEngine ?? "claude", model: s.git?.commitMessageModel || "haiku", openCodeModel: s.git?.commitMessageOpenCodeModel ?? "" }, overrides: s.projects?.overrides ?? {} };
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  cur = next;
  subs.forEach((f) => f());
}
export const useCommitGeneratorState = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => cur,
  );

/** The generator of the Project at `project`: its override fields over the global ones. The Project's Side is not known here: this machine's entry first, then another Side's. */
export function commitGeneratorOf(s: State, project: string | undefined): CommitGenerator {
  const sides = [LOCAL_SIDE, ...Object.keys(s.overrides).filter((x) => x !== LOCAL_SIDE)];
  const o = project === undefined ? undefined : sides.map((side) => (Object.hasOwn(s.overrides, side) && Object.hasOwn(s.overrides[side]!, project) ? s.overrides[side]![project]!.commitMessage : undefined)).find((x) => x);
  return { engine: o?.engine ?? s.global.engine, model: o?.model || s.global.model, openCodeModel: o?.openCodeModel || s.global.openCodeModel };
}
