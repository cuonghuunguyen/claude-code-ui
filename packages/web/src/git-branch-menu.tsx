// Branch menu of the Graph tab (docs/spec.md "Layout"): right click, long press or Shift+F10 on a ref chip or a row offers Push,
// Force push and Pull of the local branches there, each behind a dialog that shows the exact git command; Fetch is always last.
import { cloneElement, useRef, useState, type ReactElement } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { GitBranchInfo, GitBranchResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { ConfirmDialog, ITEM, POPUP } from "./session-actions.tsx";

type Client = ReturnType<typeof connect>;
export type RemoteRequest = { type: "git.fetch"; cwd: string; exact?: true } | { type: "git.push"; cwd: string; ref: string; local: string; argv: string[]; lease?: string; exact?: true } | { type: "git.pull"; cwd: string; ref: string; local: string; argv: string[]; exact?: true };
type Kind = "push" | "force" | "pull";
type Entry = { ref: string; info?: GitBranchInfo; error?: string };

const MAX_TARGETS = 5;
const name = (ref: string) => ref.replace(/^refs\/heads\//, "");
const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
/** Display form of an argv: arguments with spaces quoted. */
const command = (argv: string[]) => `git ${argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
/** Where the branch is checked out, as a short note (absent: in the session's worktree). */
const note = (i: GitBranchInfo) => (i.checkedOut === "here" ? undefined : i.checkedOut ? `checked out in ${base(i.checkedOut)}` : "not checked out here");
const ownerSentence = (i: GitBranchInfo) => (i.checkedOut === "here" ? "" : i.checkedOut ? ` ${name(i.ref)} is checked out in ${i.checkedOut}.` : ` ${name(i.ref)} is not checked out here.`);
const short7 = (h?: string) => (h ?? "").slice(0, 7);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * `children`: the element that gets the context menu (the commit list or the details refs). The target is the chip under the
 * pointer, else the local branches of the row under it, else `fallback()` (keyboard: the selected commit's).
 */
export function BranchMenu({ client, cwd, exact = false, repoName, busy, onRun, fallback, children }: { client: Client; cwd: string; exact?: boolean; repoName?: string; busy: boolean; onRun: (msg: RemoteRequest, done: string, running: string) => void; fallback: () => string[]; children: ReactElement<{ onContextMenuCapture?: (e: React.MouseEvent) => void; onPointerDownCapture?: (e: React.SyntheticEvent) => void; onTouchStartCapture?: (e: React.SyntheticEvent) => void; onKeyDownCapture?: (e: React.SyntheticEvent) => void }> }) {
  const of = (t: string) => (repoName ? `${t} of ${repoName}` : t);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dialog, setDialog] = useState<{ kind: Kind; info: GitBranchInfo }>();
  const gen = useRef(0);
  // What a press (mouse, pen or touch) landed on, kept until the menu closes. A long press on touch opens the menu from
  // `touchstart` + a timer (Base UI) and fires no `contextmenu` event, so the target cannot be taken from that event only.
  const pressed = useRef<string[] | undefined>(undefined);
  const loaded = useRef(false);
  const targetsOf = (t: Element): string[] | undefined => {
    const chip = t.closest<HTMLElement>("[data-ref]");
    const row = t.closest<HTMLElement>("[data-local-refs]");
    return chip ? [chip.dataset.ref!] : row ? (row.dataset.localRefs ?? "").split("\n") : undefined;
  };
  const load = (refs: string[]) => {
    loaded.current = true;
    const targets = [...new Set(refs.filter((r) => r.startsWith("refs/heads/")))].slice(0, MAX_TARGETS);
    const id = ++gen.current;
    setEntries(targets.map((ref) => ({ ref })));
    for (const ref of targets) {
      client.request<GitBranchResult>({ type: "git.branch", cwd, ...(exact && { exact: true as const }), ref }).then(
        (r) => id === gen.current && setEntries((p) => p.map((x) => (x.ref === ref ? { ref, info: r.branch ?? undefined, error: r.branch ? undefined : "Not a git repository" } : x))),
        (err: RequestError) => id === gen.current && setEntries((p) => p.map((x) => (x.ref === ref ? { ref, error: err.message || "git failed" } : x))),
      );
    }
  };
  // A press on no chip and no row (empty list space) is a press with no target: not the selected row.
  const press = (e: React.SyntheticEvent) => void (pressed.current = targetsOf(e.target as Element) ?? []);
  // The keyboard (Shift+F10, the menu key) has no pointer target: the selected row's branches.
  const key = () => void (pressed.current = undefined);
  // The `contextmenu` event (right click, Shift+F10) knows its target best: chip, row, else the keyboard's selection.
  const open = (e: React.MouseEvent) => {
    const refs = targetsOf(e.target as Element) ?? pressed.current ?? fallback();
    pressed.current = refs;
    load(refs);
  };
  const onOpenChange = (o: boolean) => {
    if (o && !loaded.current) load(pressed.current ?? fallback());
    if (!o) {
      loaded.current = false;
      pressed.current = undefined;
    }
  };
  const run = () => {
    const d = dialog;
    setDialog(undefined);
    if (!d) return;
    const { info } = d;
    const x = name(info.ref);
    // The command the dialog showed goes with the confirm: the daemon runs it only when it computes the same.
    if (d.kind === "pull") return onRun({ type: "git.pull", cwd, ...(exact && { exact: true as const }), ref: info.ref, local: info.local, argv: info.pull ?? [] }, `Pulled ${of(x)}`, `Pulling ${of(x)}…`);
    const force = d.kind === "force";
    onRun({ type: "git.push", cwd, ...(exact && { exact: true as const }), ref: info.ref, local: info.local, argv: (force ? info.forcePush : info.push) ?? [], ...(force && { lease: info.trackingHash }) }, `Pushed ${of(x)} to ${info.remote}${force ? " (forced)" : ""}`, `Pushing ${of(x)}…`);
  };
  const argv = dialog && (dialog.kind === "push" ? dialog.info.push : dialog.kind === "force" ? dialog.info.forcePush : dialog.info.pull);
  const i = dialog?.info;
  const x = i ? name(i.ref) : "";
  const target = i?.tracking ? i.tracking.replace(/^refs\/remotes\//, "") : i?.remote;
  const text = !i || !dialog ? "" : dialog.kind === "force"
    ? `Replaces ${target} (${short7(i.trackingHash)}) with ${x} (${short7(i.local)}). ${plural(i.behind ?? 0, "commit")} on the remote that ${x} does not have will be lost. Refused if ${target} changed since your last fetch.${i.isDefault ? " This is the remote's default branch." : ""}${ownerSentence(i)}`
    : dialog.kind === "push"
      ? `${x} (${short7(i.local)}) → ${target ?? i.remote}${i.ahead !== undefined ? `: ${plural(i.ahead, "commit")} ahead, ${i.behind} behind` : ""}. A push the remote cannot fast-forward is rejected.${ownerSentence(i)}`
      : `${i.checkedOut ? "Fast-forward only: fails if the branches diverged." : "Not checked out: fast-forward only."} ${i.upstream ?? ""}`.trim() + ownerSentence(i);
  const title = !i || !dialog ? "" : dialog.kind === "pull" ? `Pull ${x}?` : dialog.kind === "force" ? `Force push ${x} to ${i.remote}?` : `Push ${x} to ${i.remote}?`;
  const many = entries.length > 1;
  return (
    <>
      <ContextMenu.Root onOpenChange={onOpenChange}>
        <ContextMenu.Trigger render={cloneElement(children, { onContextMenuCapture: open, onPointerDownCapture: press, onTouchStartCapture: press, onKeyDownCapture: key })} />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className={cn(POPUP, "max-w-[calc(100vw-1rem)]")} data-testid="branch-menu">
              {entries.map((en) => (
                <div key={en.ref} role="group" aria-label={name(en.ref)}>
                  <div className="px-2 pt-1 text-muted-foreground text-xs" data-testid="branch-menu-head">
                    {(many || (en.info && note(en.info))) && <div className="truncate font-medium">{name(en.ref)}</div>}
                    {en.info && note(en.info) && <div>{note(en.info)}</div>}
                  </div>
                  {!en.info && (
                    <ContextMenu.Item className={ITEM} disabled>
                      {en.error ?? "Loading…"}
                    </ContextMenu.Item>
                  )}
                  {en.info && <Actions info={en.info} busy={busy} onPick={(kind) => setDialog({ kind, info: en.info! })} />}
                </div>
              ))}
              {entries.length === 0 && (
                <ContextMenu.Item className={ITEM} disabled data-testid="branch-none">
                  No local branch here
                </ContextMenu.Item>
              )}
              <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
              <ContextMenu.Item className={ITEM} disabled={busy} onClick={() => onRun({ type: "git.fetch", cwd, ...(exact && { exact: true as const }) }, of("Fetched all remotes"), `${of("Fetching all remotes")}…`)} data-testid="branch-fetch">
                Fetch all remotes
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <ConfirmDialog
        open={!!dialog}
        title={title}
        description={text}
        confirm={dialog?.kind === "force" ? "Force push" : dialog?.kind === "pull" ? "Pull" : "Push"}
        destructive={dialog?.kind === "force"}
        onConfirm={run}
        onCancel={() => setDialog(undefined)}
        testId={dialog?.kind === "force" ? "git-force-push" : dialog?.kind === "pull" ? "git-pull" : "git-push"}
      >
        {argv && (
          <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-secondary p-2 font-mono text-xs" data-testid="git-command">
            {command(argv)}
          </pre>
        )}
      </ConfirmDialog>
    </>
  );
}

function Actions({ info, busy, onPick }: { info: GitBranchInfo; busy: boolean; onPick: (k: Kind) => void }) {
  const row = (kind: Kind, label: string, argv: string[] | undefined, why: string | undefined, id: string, danger = false) => (
    <ContextMenu.Item className={cn(ITEM, "h-auto min-h-8 flex-col items-start justify-center py-1 max-md:min-h-11", danger && "text-destructive")} disabled={busy || !argv} onClick={() => onPick(kind)} title={!argv ? why : undefined} data-testid={id}>
      <span>{label}</span>
      {!argv && why && <span className="text-muted-foreground text-xs">{why}</span>}
    </ContextMenu.Item>
  );
  return (
    <>
      {row("push", "Push", info.push, info.why?.push, "branch-push")}
      {row("force", "Force push…", info.forcePush, info.why?.forcePush, "branch-force-push", true)}
      {row("pull", "Pull", info.pull, info.why?.pull, "branch-pull")}
    </>
  );
}
