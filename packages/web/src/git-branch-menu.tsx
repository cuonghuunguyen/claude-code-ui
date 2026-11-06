// Branch menu of the Graph tab (docs/spec.md "Layout"): right click, long press or Shift+F10 on a ref chip or a row offers Push,
// Force push and Pull of the local branches there, each behind a dialog that shows the exact git command; Fetch is always last.
import { cloneElement, useRef, useState, type ReactElement } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { GitBranchInfo, GitBranchResult, GitCommitMenu } from "@claude-ui/protocol";
import { CommitItems, ResetDialog, type CommitActionRequest } from "./git-commit-menu.tsx";
import type { OpReply } from "./git-remote-ops.ts";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { ConfirmDialog, ITEM, POPUP } from "./session-actions.tsx";
import { t, useT } from "./i18n.ts";

type Client = ReturnType<typeof connect>;
export type RemoteRequest = { type: "git.fetch"; cwd: string; exact?: true } | { type: "git.push"; cwd: string; ref: string; local: string; argv: string[]; lease?: string; tracking?: string; exact?: true } | { type: "git.pull"; cwd: string; ref: string; local: string; argv: string[]; tracking?: string; exact?: true } | { type: "git.merge" | "git.rebase"; cwd: string; ref: string; local: string; headRef: string; headHash: string; argv: string[]; exact?: true } | CommitActionRequest | { type: "git.checkout"; cwd: string; ref: string; smart?: boolean; exact?: true } | { type: "git.branchCreate"; cwd: string; name: string; at?: string; checkout?: boolean; smart?: boolean; exact?: true };
export type Kind = "push" | "force" | "pull" | "merge" | "rebase";
type Done = string | ((r: OpReply) => string);
type Entry = { ref: string; info?: GitBranchInfo; error?: string; remote?: boolean };
/** A checkout or create the daemon refused with `local_changes`: Smart checkout resends it with `smart`. */
type Smart = { msg: Extract<RemoteRequest, { smart?: boolean }>; done: Done; running: string; target: string; message: string };
type OnRun = (msg: RemoteRequest, done: Done, running: string, onFail?: (e: RequestError) => boolean) => void;

/** "<text> of <repo>" while the repository is named (the Graph shows the repository selector), else the text. */
export const ofRepo = (text: string, repoName?: string) => (repoName ? t("sidebar.git.ofRepo", { text, repo: repoName }) : text);
const MAX_TARGETS = 5;
const name = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
/** Display form of an argv: arguments with spaces quoted. */
export const command = (argv: string[]) => `git ${argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
/** Where the branch is checked out, as a short note (absent: in the session's worktree). */
const note = (i: GitBranchInfo) => (i.checkedOut === "here" ? undefined : i.checkedOut ? t("sidebar.git.checkedOutIn", { name: base(i.checkedOut) }) : t("sidebar.git.notCheckedOut"));
const ownerSentence = (i: GitBranchInfo) => (i.checkedOut === "here" ? "" : ` ${i.checkedOut ? t("sidebar.git.ownerIn", { name: base(i.checkedOut) }) : t("sidebar.git.ownerNone")}`);
const short7 = (h?: string) => (h ?? "").slice(0, 7);
const commits = (count: number) => t("sidebar.git.commits", { count });

/**
 * `children`: the element that gets the context menu (the commit list or the details refs). The target is the chip under the
 * pointer, else the local branches of the row under it, else `fallback()` (keyboard: the selected commit's).
 */
export function BranchMenu({ client, cwd, exact = false, repoName, busy, onRun, fallback, hash, newBranchOnly, children }: { client: Client; cwd: string; exact?: boolean; repoName?: string; busy: boolean; onRun: OnRun; fallback: () => string[]; /** The keyboard's commit (the selected row); absent: no commit section without a row under the pointer. */ hash?: () => string | undefined; /** The commit only names New branch (the details pane): no commit section. */ newBranchOnly?: boolean; children: ReactElement<{ onContextMenuCapture?: (e: React.MouseEvent) => void; onPointerDownCapture?: (e: React.SyntheticEvent) => void; onTouchStartCapture?: (e: React.SyntheticEvent) => void; onKeyDownCapture?: (e: React.SyntheticEvent) => void }> }) {
  const t = useT();
  const of = (text: string) => ofRepo(text, repoName);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dialog, setDialog] = useState<{ kind: Kind; info: GitBranchInfo }>();
  const [fresh, setFresh] = useState(false);
  const [smart, setSmart] = useState<Smart>();
  const gen = useRef(0);
  // What a press (mouse, pen or touch) landed on, kept until the menu closes. A long press on touch opens the menu from
  // `touchstart` + a timer (Base UI) and fires no `contextmenu` event, so the target cannot be taken from that event only.
  const pressed = useRef<string[] | undefined>(undefined);
  const loaded = useRef(false);
  // The commit menu: the hash of the row under the press ("" = a press on no row), kept like `pressed`.
  const [commit, setCommit] = useState<string>();
  const [reset, setReset] = useState<GitCommitMenu>();
  const pressedHash = useRef<string | undefined>(undefined);
  const hashOf = (t: Element) => t.closest<HTMLElement>("[data-hash]")?.dataset.hash;
  const targetsOf = (t: Element): string[] | undefined => {
    const chip = t.closest<HTMLElement>("[data-ref]");
    const row = t.closest<HTMLElement>("[data-local-refs]");
    return chip ? [chip.dataset.ref!] : row ? (row.dataset.localRefs ?? "").split("\n") : undefined;
  };
  const load = (refs: string[], hash: string | undefined) => {
    loaded.current = true;
    setCommit(hash);
    const all = [...new Set(refs)].filter((r) => r.startsWith("refs/heads/") || (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")));
    const targets = all.slice(0, MAX_TARGETS);
    const id = ++gen.current;
    setEntries(targets.map((ref) => ({ ref, remote: ref.startsWith("refs/remotes/") || undefined })));
    for (const ref of targets.filter((r) => r.startsWith("refs/heads/"))) {
      client.request<GitBranchResult>({ type: "git.branch", cwd, ...(exact && { exact: true as const }), ref }).then(
        (r) => id === gen.current && setEntries((p) => p.map((x) => (x.ref === ref ? { ref, info: r.branch ?? undefined, error: r.branch ? undefined : t("sidebar.git.notRepo") } : x))),
        (err: RequestError) => id === gen.current && setEntries((p) => p.map((x) => (x.ref === ref ? { ref, error: err.message || t("sidebar.git.failed") } : x))),
      );
    }
  };
  // A press on no chip and no row (empty list space) is a press with no target: not the selected row.
  const press = (e: React.SyntheticEvent) => {
    pressed.current = targetsOf(e.target as Element) ?? [];
    pressedHash.current = hashOf(e.target as Element) ?? "";
  };
  // The keyboard (Shift+F10, the menu key) has no pointer target: the selected row's branches.
  const key = () => {
    pressed.current = undefined;
    pressedHash.current = undefined;
  };
  // The `contextmenu` event (right click, Shift+F10) knows its target best: chip, row, else the keyboard's selection.
  const open = (e: React.MouseEvent) => {
    const refs = targetsOf(e.target as Element) ?? pressed.current ?? fallback();
    pressed.current = refs;
    load(refs, hashOf(e.target as Element) ?? pressedHash.current ?? hash?.());
  };
  const onOpenChange = (o: boolean) => {
    if (o && !loaded.current) load(pressed.current ?? fallback(), pressedHash.current ?? hash?.());
    if (!o) {
      loaded.current = false;
      pressed.current = undefined;
      pressedHash.current = undefined;
    }
  };
  /** Checkout and create run at once; a `local_changes` refusal opens the Smart checkout dialog instead of a result line. */
  const send = (msg: Extract<RemoteRequest, { smart?: boolean }>, done: Done, running: string, target: string) =>
    onRun(msg, done, running, (e) => e.code === "local_changes" && (setSmart({ msg, done, running, target, message: e.message }), true));
  const checkout = (ref: string) => {
    const x = name(ref);
    const stopped = (r: OpReply) => !!r.written?.operation;
    send({ type: "git.checkout", cwd, ...(exact && { exact: true as const }), ref }, (r) => of(t(stopped(r) ? "sidebar.git.checkedOutStopped" : "sidebar.git.checkedOut", { target: x })), t("sidebar.git.checkingOut", { target: of(x) }), x);
  };
  const many = entries.length > 1;
  return (
    <>
      <ContextMenu.Root onOpenChange={onOpenChange}>
        <ContextMenu.Trigger render={cloneElement(children, { onContextMenuCapture: open, onPointerDownCapture: press, onTouchStartCapture: press, onKeyDownCapture: key })} />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className={cn(POPUP, "max-w-[calc(100vw-1rem)]")} data-testid="branch-menu">
              {commit && !newBranchOnly && (
                <>
                  <CommitItems key={commit} client={client} cwd={cwd} exact={exact} repoName={repoName} hash={commit} busy={busy} onRun={onRun} onReset={setReset} />
                  <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
                </>
              )}
              {entries.map((en) => (
                <div key={en.ref} role="group" aria-label={name(en.ref)}>
                  <div className="px-2 pt-1 text-muted-foreground text-xs" data-testid="branch-menu-head">
                    {(many || en.remote || (en.info && note(en.info))) && <div className="truncate font-medium">{name(en.ref)}</div>}
                    {en.info && note(en.info) && <div>{note(en.info)}</div>}
                  </div>
                  {en.remote && (
                    <ContextMenu.Item className={cn(ITEM, "max-md:min-h-11")} disabled={busy} onClick={() => checkout(en.ref)} data-testid="branch-checkout-remote">
                      {t("sidebar.git.checkoutRemote")}
                    </ContextMenu.Item>
                  )}
                  {!en.remote && !en.info && (
                    <ContextMenu.Item className={ITEM} disabled>
                      {en.error ?? t("sidebar.git.loading")}
                    </ContextMenu.Item>
                  )}
                  {en.info && <Actions info={en.info} busy={busy} onPick={(kind) => setDialog({ kind, info: en.info! })} onCheckout={() => checkout(en.ref)} />}
                </div>
              ))}
              {entries.length === 0 && (
                <ContextMenu.Item className={ITEM} disabled data-testid="branch-none">
                  {t("sidebar.git.noLocal")}
                </ContextMenu.Item>
              )}
              <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
              <ContextMenu.Item className={cn(ITEM, "max-md:min-h-11")} disabled={busy} onClick={() => setFresh(true)} data-testid="branch-new">
                {commit ? t("sidebar.git.newBranchFrom", { from: short7(commit) }) : t("sidebar.git.newBranchHead")}
              </ContextMenu.Item>
              <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
              <ContextMenu.Item className={ITEM} disabled={busy} onClick={() => onRun({ type: "git.fetch", cwd, ...(exact && { exact: true as const }) }, of(t("sidebar.git.fetched")), `${of(t("sidebar.git.fetching"))}…`)} data-testid="branch-fetch">
                {t("sidebar.git.fetchAll")}
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {fresh && <NewBranchDialog from={commit} onCancel={() => setFresh(false)} onCreate={(n, co) => {
        setFresh(false);
        const stopped = (r: OpReply) => !!r.written?.operation;
        send({ type: "git.branchCreate", cwd, ...(exact && { exact: true as const }), name: n, ...(commit && { at: commit }), checkout: co }, (r) => of(t(co ? (stopped(r) ? "sidebar.git.checkedOutStopped" : "sidebar.git.createdCheckedOut") : "sidebar.git.created", { target: n })), t("sidebar.git.creating", { target: of(n) }), n);
      }} />}
      <ConfirmDialog
        open={!!smart}
        title={t("sidebar.git.smartTitle")}
        description={t("sidebar.git.smartText", { target: smart?.target ?? "" })}
        confirm={t("sidebar.git.smartConfirm")}
        onConfirm={() => {
          const s = smart;
          setSmart(undefined);
          if (s) onRun({ ...s.msg, smart: true }, s.done, s.running);
        }}
        onCancel={() => setSmart(undefined)}
        testId="git-smart-checkout"
      >
        <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-secondary p-2 font-mono text-muted-foreground text-xs" data-testid="git-smart-message">
          {smart?.message}
        </pre>
      </ConfirmDialog>
      <BranchDialog dialog={dialog} cwd={cwd} exact={exact} repoName={repoName} onRun={onRun} onClose={() => setDialog(undefined)} />
      <ResetDialog client={client} cwd={cwd} exact={exact} repoName={repoName} target={reset} onRun={onRun} onClose={() => setReset(undefined)} />
    </>
  );
}

/** The dialog before a push, force push or pull: the exact git command; Confirm sends it with the hashes the menu showed. `dialog` undefined: closed. */
export function BranchDialog({ dialog, cwd, exact = false, repoName, onRun, onClose }: { dialog?: { kind: Kind; info: GitBranchInfo }; cwd: string; exact?: boolean; repoName?: string; onRun: OnRun; onClose: () => void }) {
  const t = useT();
  const of = (text: string) => ofRepo(text, repoName);
  const run = () => {
    const d = dialog;
    onClose();
    if (!d) return;
    const { info } = d;
    const x = name(info.ref);
    // The command the dialog showed goes with the confirm: the daemon runs it only when it computes the same.
    if (d.kind === "merge" || d.kind === "rebase") {
      const verb = d.kind === "merge" ? "merge" : "rebase";
      const stopped = (r: OpReply) => !!r.written?.operation;
      const line = (stop: string, ok: string) => (r: OpReply) => (stopped(r) ? stop : ok);
      return onRun({ type: `git.${verb}`, cwd, ...(exact && { exact: true as const }), ref: info.ref, local: info.local, headRef: info.headRef ?? "", headHash: info.headHash ?? "", argv: (d.kind === "merge" ? info.merge : info.rebase) ?? [] }, line(of(t(`sidebar.git.${verb}Stopped`, { target: x })), of(t(`sidebar.git.${verb}Done`, { target: x }))), t(`sidebar.git.${verb}Running`, { target: of(x) }));
    }
    if (d.kind === "pull") return onRun({ type: "git.pull", cwd, ...(exact && { exact: true as const }), ref: info.ref, local: info.local, argv: info.pull ?? [], ...(info.upstreamHash && { tracking: info.upstreamHash }) }, t("sidebar.git.pulled", { target: of(x) }), t("sidebar.git.pulling", { target: of(x) }));
    const force = d.kind === "force";
    onRun({ type: "git.push", cwd, ...(exact && { exact: true as const }), ref: info.ref, local: info.local, argv: (force ? info.forcePush : info.push) ?? [], ...(force && { lease: info.trackingHash }), ...(info.trackingHash && { tracking: info.trackingHash }) }, t(force ? "sidebar.git.pushedForced" : "sidebar.git.pushed", { target: of(x), remote: info.remote ?? "" }), t("sidebar.git.pushing", { target: of(x) }));
  };
  const argv = dialog && ({ push: dialog.info.push, force: dialog.info.forcePush, pull: dialog.info.pull, merge: dialog.info.merge, rebase: dialog.info.rebase })[dialog.kind];
  const i = dialog?.info;
  const x = i ? name(i.ref) : "";
  const target = i?.tracking ? i.tracking.replace(/^refs\/remotes\//, "") : i?.remote;
  // The title names the branch and the remote; the text adds only what the title does not: hashes, counts, where the remote
  // branch lands when its name differs, and where the branch is checked out.
  const lands = i && target && target !== `${i.remote}/${x}` ? ` ${t("sidebar.git.lands", { target })}` : "";
  const cur = i?.headRef ? name(i.headRef) : "";
  const text = !i || !dialog ? "" : dialog.kind === "merge" || dialog.kind === "rebase"
    ? t(dialog.kind === "merge" ? "sidebar.git.mergeText" : "sidebar.git.rebaseText", { branch: x, current: cur, localHash: short7(i.local), headHash: short7(i.headHash) })
    : dialog.kind === "force"
    ? `${t("sidebar.git.forceText", { remoteHash: short7(i.trackingHash), localHash: short7(i.local), commits: commits(i.behind ?? 0) })}${lands}${i.isDefault ? ` ${t("sidebar.git.defaultBranch")}` : ""}${ownerSentence(i)}`
    : dialog.kind === "push"
      ? t(i.ahead !== undefined ? "sidebar.git.pushTextCounts" : "sidebar.git.pushText", { localHash: short7(i.local), ahead: commits(i.ahead ?? 0), behind: i.behind ?? 0 }) + lands + ownerSentence(i)
      : // Pull is unavailable from another worktree, so its text covers both cases left.
        t(i.checkedOut ? "sidebar.git.pullDiverge" : "sidebar.git.pullNotCheckedOut", { upstream: i.upstream ?? "" });
  const title = !i || !dialog ? "" : dialog.kind === "merge" || dialog.kind === "rebase" ? t(dialog.kind === "merge" ? "sidebar.git.titleMerge" : "sidebar.git.titleRebase", { branch: x, current: cur }) : dialog.kind === "pull" ? t("sidebar.git.titlePull", { branch: x }) : t(dialog.kind === "force" ? "sidebar.git.titleForce" : "sidebar.git.titlePush", { branch: x, remote: i.remote ?? "" });
  return (
    <ConfirmDialog
        open={!!dialog}
        title={title}
        description={text}
        confirm={t(dialog?.kind === "force" ? "sidebar.git.forcePush" : dialog?.kind === "pull" ? "sidebar.git.pull" : dialog?.kind === "merge" ? "sidebar.git.merge" : dialog?.kind === "rebase" ? "sidebar.git.rebase" : "sidebar.git.push")}
        destructive={dialog?.kind === "force"}
        onConfirm={run}
        onCancel={onClose}
        testId={dialog?.kind === "force" ? "git-force-push" : dialog?.kind === "pull" ? "git-pull" : dialog?.kind === "merge" ? "git-merge" : dialog?.kind === "rebase" ? "git-rebase" : "git-push"}
      >
        {argv && (
          <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-secondary p-2 font-mono text-muted-foreground text-xs" data-testid="git-command">
            {command(argv)}
          </pre>
        )}
    </ConfirmDialog>
  );
}

/** Name field and "Check out" box; mounted only while open, so each open starts blank. */
function NewBranchDialog({ from, onCancel, onCreate }: { from?: string; onCancel: () => void; onCreate: (name: string, checkout: boolean) => void }) {
  const t = useT();
  const [n, setN] = useState("");
  const [co, setCo] = useState(true);
  const go = () => n.trim() && onCreate(n.trim(), co);
  return (
    <ConfirmDialog open title={t("sidebar.git.newBranchTitle")} description={from ? t("sidebar.git.newBranchText", { from: short7(from) }) : t("sidebar.git.newBranchTextHead")} confirm={t("sidebar.git.newBranchCreate")} confirmDisabled={!n.trim()} onConfirm={go} onCancel={onCancel} testId="git-new-branch">
      <input autoFocus aria-label={t("sidebar.git.newBranchName")} placeholder={t("sidebar.git.newBranchName")} value={n} onChange={(e) => setN(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go())} className="h-9 rounded-md border bg-transparent px-2 text-sm max-md:h-11 focus-visible:outline-2 focus-visible:outline-ring" data-testid="git-new-branch-name" />
      <label className="flex items-center gap-2 text-sm max-md:min-h-11">
        <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={co} onChange={(e) => setCo(e.target.checked)} data-testid="git-new-branch-checkout" />
        {t("sidebar.git.newBranchCheckout")}
      </label>
    </ConfirmDialog>
  );
}

function Actions({ info, busy, onPick, onCheckout }: { info: GitBranchInfo; busy: boolean; onPick: (k: Kind) => void; onCheckout: () => void }) {
  const t = useT();
  const cur = info.headRef ? name(info.headRef) : "HEAD";
  const row = (kind: Kind, label: string, argv: string[] | undefined, why: string | undefined, id: string, danger = false) => (
    <ContextMenu.Item className={cn(ITEM, "h-auto min-h-8 flex-col items-start justify-center py-1 max-md:min-h-11", danger && "text-destructive")} disabled={busy || !argv} onClick={() => onPick(kind)} title={!argv ? why : undefined} data-testid={id}>
      <span>{label}</span>
      {!argv && why && <span className="text-muted-foreground text-xs">{why}</span>}
    </ContextMenu.Item>
  );
  const here = info.checkedOut === "here";
  return (
    <>
      <ContextMenu.Item className={cn(ITEM, "h-auto min-h-8 flex-col items-start justify-center py-1 max-md:min-h-11")} disabled={busy || here} onClick={onCheckout} data-testid="branch-checkout">
        <span>{t("sidebar.git.checkout")}</span>
        {here && <span className="text-muted-foreground text-xs">{t("sidebar.git.checkoutCurrent")}</span>}
      </ContextMenu.Item>
      {row("push", t("sidebar.git.push"), info.push, info.why?.push, "branch-push")}
      {row("force", t("sidebar.git.forcePushMenu"), info.forcePush, info.why?.forcePush, "branch-force-push", true)}
      {row("pull", t("sidebar.git.pull"), info.pull, info.why?.pull, "branch-pull")}
      <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
      {row("merge", t("sidebar.git.mergeMenu", { current: cur }), info.merge, info.why?.merge, "branch-merge")}
      {row("rebase", t("sidebar.git.rebaseMenu", { current: cur, branch: name(info.ref) }), info.rebase, info.why?.rebase, "branch-rebase")}
    </>
  );
}
