// The Graph tab's stash section (docs/spec.md "Layout", Graph tab; wire `git.stashList` and the writes): list, push dialog, apply, pop, drop with a confirm.
import { useEffect, useRef, useState } from "react";
import type { GitStash, GitStashListResult } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { connect, RequestError } from "./client.ts";
import { ofRepo } from "./git-branch-menu.tsx";
import type { OpReply, StashRequest } from "./git-remote-ops.ts";
import { dateFormat, useT } from "./i18n.ts";
import { ConfirmDialog } from "./session-actions.tsx";
import { timeAgo } from "./sessions.ts";

type Client = ReturnType<typeof connect>;
const when = (time: number) => (Date.now() / 1000 - time < 7 * 86400 ? timeAgo(time * 1000) : dateFormat().format(new Date(time * 1000)));
const INPUT = "h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
type Verb = "Apply" | "Pop" | "Drop";
const ACTION = {
  Apply: { done: "files.graph.stashApplied", running: "files.graph.stashApplying" },
  Pop: { done: "files.graph.stashPopped", running: "files.graph.stashPopping" },
  Drop: { done: "files.graph.stashDropped", running: "files.graph.stashDropping" },
} as const;
const TYPE = { Apply: "git.stashApply", Pop: "git.stashPop", Drop: "git.stashDrop" } as const;

export function StashSection({ client, cwd, exact, repoName, version, busy, onRun, open, pushAsk = 0 }: { client: Client; cwd: string; exact?: boolean; repoName?: string; version: number; busy: boolean; onRun: (msg: StashRequest, done: string | ((r: OpReply) => string), running: string) => void; open: boolean; /** Counts the palette's Stash asks: each opens the message dialog. */ pushAsk?: number }) {
  const t = useT();
  const of = (x: string) => ofRepo(x, repoName);
  const ex = exact ? { exact: true as const } : {};
  const [stashes, setStashes] = useState<GitStash[]>();
  const [error, setError] = useState<string>();
  const [push, setPush] = useState<{ message: string; untracked: boolean }>();
  const [drop, setDrop] = useState<GitStash>();
  const gen = useRef(0);
  useEffect(() => {
    if (pushAsk) setPush({ message: "", untracked: false });
  }, [pushAsk]);
  // The list of another repository must not stay actionable.
  useEffect(() => setStashes(undefined), [cwd]);
  useEffect(() => {
    if (!open) return;
    const id = ++gen.current;
    client.request<GitStashListResult>({ type: "git.stashList", cwd, ...ex }).then(
      (r) => id === gen.current && (setStashes(r.stashes ?? []), setError(undefined)),
      (e: RequestError) => id === gen.current && setError(e.message),
    );
  }, [open, cwd, version]);
  if (!open) return null;
  const ref = (s: GitStash) => `stash@{${s.index}}`;
  const act = (verb: Verb, s: GitStash) => {
    const at = of(ref(s));
    const { done, running } = ACTION[verb];
    const stop = verb === "Drop" ? undefined : t("files.graph.stashStopped", { verb: t(running), target: at });
    onRun({ type: TYPE[verb], cwd, ...ex, index: s.index, hash: s.hash }, (r) => (stop && r.written?.operation ? stop : t(done, { target: at })), `${t(running)} ${at}…`);
  };
  const confirmPush = () => {
    const p = push;
    setPush(undefined);
    if (p) onRun({ type: "git.stashPush", cwd, ...ex, ...(p.message.trim() && { message: p.message.trim() }), ...(p.untracked && { includeUntracked: true }) }, of(t("files.graph.stashed")), `${of(t("files.graph.stashing"))}…`);
  };
  const confirmDrop = () => {
    const s = drop;
    setDrop(undefined);
    if (s) act("Drop", s);
  };
  return (
    <div className="flex max-h-48 shrink-0 flex-col gap-1 overflow-y-auto border-b px-3 py-2 text-sm" data-testid="stash-section">
      <div className="flex items-center gap-2">
        <span className="flex-1 font-medium">{t("files.graph.stashes")}{stashes ? ` (${stashes.length})` : ""}</span>
        <Button size="sm" variant="outline" className="max-md:h-11" disabled={busy} onClick={() => setPush({ message: "", untracked: false })} data-testid="stash-push">
          {t("files.graph.stashPush")}
        </Button>
      </div>
      {error && <p className="text-destructive" role="alert">{error}</p>}
      {stashes?.length === 0 && <p className="text-muted-foreground">{t("files.graph.noStashes")}</p>}
      {stashes?.map((s) => (
        <div key={s.hash} className="flex items-center gap-2" data-testid="stash-row" data-hash={s.hash}>
          <span className="shrink-0 font-mono text-muted-foreground text-xs">{ref(s)}</span>
          <span className="min-w-0 flex-1 truncate" title={s.message}>{s.message}</span>
          <span className="shrink-0 text-muted-foreground text-xs max-md:hidden">{when(s.time)}</span>
          <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={() => act("Apply", s)} data-testid="stash-apply">{t("files.graph.stashApply")}</Button>
          <Button size="sm" variant="ghost" className="max-md:h-11" disabled={busy} onClick={() => act("Pop", s)} data-testid="stash-pop">{t("files.graph.stashPop")}</Button>
          <Button size="sm" variant="ghost" className="text-destructive max-md:h-11" disabled={busy} onClick={() => setDrop(s)} data-testid="stash-drop">{t("files.graph.stashDrop")}</Button>
        </div>
      ))}
      <ConfirmDialog open={!!push} title={t("files.graph.stashTitle")} description={t("files.graph.stashPushText")} confirm={t("files.graph.stashConfirm")} onConfirm={confirmPush} onCancel={() => setPush(undefined)} testId="git-stash-push">
        <input autoFocus value={push?.message ?? ""} onChange={(e) => setPush((p) => p && { ...p, message: e.target.value })} onKeyDown={(e) => e.key === "Enter" && confirmPush()} placeholder={t("files.graph.stashMessage")} aria-label={t("files.graph.stashMessage")} maxLength={4096} className={INPUT} data-testid="stash-message" />
        <label className="flex items-center gap-2 text-sm max-md:min-h-11">
          <input type="checkbox" checked={push?.untracked ?? false} onChange={(e) => setPush((p) => p && { ...p, untracked: e.target.checked })} data-testid="stash-untracked" />
          {t("files.graph.stashUntracked")}
        </label>
      </ConfirmDialog>
      <ConfirmDialog open={!!drop} destructive title={t("files.graph.stashDropTitle", { target: drop ? ref(drop) : "" })} description={`${drop?.message ?? ""}. ${t("files.graph.stashDropText")}`} confirm={t("files.graph.stashDrop")} onConfirm={confirmDrop} onCancel={() => setDrop(undefined)} testId="git-stash-drop" />
    </div>
  );
}
