// Context menu of the Graph tab (docs/spec.md "Layout"): right click, long press or Shift+F10 on a branch chip offers that branch's actions
// (shared with the branch popup), on a row the commit's actions; each destructive one behind a dialog that shows the exact git command.
import { cloneElement, useEffect, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
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
/** A checkout or create the daemon refused with `local_changes`: Smart checkout resends it with `smart`. */
type Smart = { msg: Extract<RemoteRequest, { smart?: boolean }>; done: Done; running: string; target: string; message: string };
type OnRun = (msg: RemoteRequest, done: Done, running: string, onFail?: (e: RequestError) => boolean) => void;

/** "<text> of <repo>" while the repository is named (the Graph shows the repository selector), else the text. */
export const ofRepo = (text: string, repoName?: string) => (repoName ? t("sidebar.git.ofRepo", { text, repo: repoName }) : text);
const name = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
/** Display form of an argv: arguments with spaces quoted. */
export const command = (argv: string[]) => `git ${argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
/** Where the branch is checked out, as a short note (absent: in the session's worktree). */
const note = (i: GitBranchInfo) => (i.checkedOut === "here" ? undefined : i.checkedOut ? t("sidebar.git.checkedOutIn", { name: base(i.checkedOut) }) : t("sidebar.git.notCheckedOut"));
const ownerSentence = (i: GitBranchInfo) => (i.checkedOut === "here" ? "" : ` ${i.checkedOut ? t("sidebar.git.ownerIn", { name: base(i.checkedOut) }) : t("sidebar.git.ownerNone")}`);
const short7 = (h?: string) => (h ?? "").slice(0, 7);
const commits = (count: number) => t("sidebar.git.commits", { count });

type Target = { ref?: string; hash?: string };
const isBranch = (r: string) => r.startsWith("refs/heads/") || (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD"));
/** What a press landed on: a branch chip (`data-ref`), else the commit row (`data-hash`). `hash` "" = a press on no row. */
const targetOf = (el: Element): Target => {
  const ref = el.closest<HTMLElement>("[data-ref]")?.dataset.ref;
  return { ref: ref && isBranch(ref) ? ref : undefined, hash: el.closest<HTMLElement>("[data-hash]")?.dataset.hash };
};

/** Dialogs and runners of the branch actions, shared by the context menu and the branch popup. Render `dialogs` once. */
export function useBranchHost({ client, cwd, exact = false, repoName, busy, onRun }: { client: Client; cwd: string; exact?: boolean; repoName?: string; busy: boolean; onRun: OnRun }) {
  const t = useT();
  const of = (text: string) => ofRepo(text, repoName);
  const [dialog, setDialog] = useState<{ kind: Kind; info: GitBranchInfo }>();
  const [fresh, setFresh] = useState<{ at?: string; label?: string }>();
  const [smart, setSmart] = useState<Smart>();
  const [reset, setReset] = useState<GitCommitMenu>();
  const ex = exact ? { exact: true as const } : {};
  const stopped = (r: OpReply) => !!r.written?.operation;
  /** Checkout and create run at once; a `local_changes` refusal opens the Smart checkout dialog instead of a result line. */
  const send = (msg: Extract<RemoteRequest, { smart?: boolean }>, done: Done, running: string, target: string) =>
    onRun(msg, done, running, (e) => e.code === "local_changes" && (setSmart({ msg, done, running, target, message: e.message }), true));
  /** `smart`: carry the local changes at once (the palette's Smart checkout), no refusal first. */
  const checkout = (ref: string, smart?: boolean) => {
    const x = name(ref);
    send({ type: "git.checkout", cwd, ...ex, ref, ...(smart && { smart: true }) }, (r) => of(t(stopped(r) ? "sidebar.git.checkedOutStopped" : "sidebar.git.checkedOut", { target: x })), t("sidebar.git.checkingOut", { target: of(x) }), x);
  };
  const dialogs = (
    <>
      {fresh && <NewBranchDialog from={fresh.label ?? ""} onCancel={() => setFresh(undefined)} onCreate={(n, co) => {
        const { at } = fresh;
        setFresh(undefined);
        send({ type: "git.branchCreate", cwd, ...ex, name: n, ...(at && { at }), checkout: co }, (r) => of(t(co ? (stopped(r) ? "sidebar.git.checkedOutStopped" : "sidebar.git.createdCheckedOut") : "sidebar.git.created", { target: n })), t("sidebar.git.creating", { target: of(n) }), n);
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
  return { busy, checkout, pick: (kind: Kind, info: GitBranchInfo) => setDialog({ kind, info }), newBranch: (at?: string, label?: string) => setFresh({ at, label }), reset: setReset, dialogs };
}
export type BranchHost = ReturnType<typeof useBranchHost>;

/**
 * `children`: the element that gets the context menu (the commit list or the details refs). A press on a branch chip opens
 * that branch's actions (the popup's submenu); a press on a row (or a tag or HEAD chip) opens the commit's actions.
 * Keyboard (Shift+F10): the selected row's commit.
 */
export function BranchMenu({ client, cwd, exact = false, repoName, busy, onRun, hash, children }: { client: Client; cwd: string; exact?: boolean; repoName?: string; busy: boolean; onRun: OnRun; /** The keyboard's commit (the selected row). */ hash?: () => string | undefined; children: ReactElement<{ onContextMenuCapture?: (e: React.MouseEvent) => void; onPointerDownCapture?: (e: React.SyntheticEvent) => void; onTouchStartCapture?: (e: React.SyntheticEvent) => void; onKeyDownCapture?: (e: React.SyntheticEvent) => void }> }) {
  const t = useT();
  const host = useBranchHost({ client, cwd, exact, repoName, busy, onRun });
  const [target, setTarget] = useState<Target>({});
  // What a press (mouse, pen or touch) landed on, kept until the menu closes. A long press on touch opens the menu from
  // `touchstart` + a timer (Base UI) and fires no `contextmenu` event, so the target cannot be taken from that event only.
  const pressed = useRef<Target | undefined>(undefined);
  const loaded = useRef(false);
  // A press on no chip and no row (empty list space) is a press with no target: not the selected row.
  const press = (e: React.SyntheticEvent) => void (pressed.current = (({ ref, hash }) => ({ ref, hash: hash ?? "" }))(targetOf(e.target as Element)));
  const key = () => void (pressed.current = undefined);
  const load = (x: Target) => (loaded.current = true, setTarget(x));
  // The `contextmenu` event (right click, Shift+F10) knows its target best: chip, row, else the press, else the keyboard's selection.
  const open = (e: React.MouseEvent) => {
    const x = targetOf(e.target as Element);
    load(x.ref || x.hash ? x : (pressed.current ?? { hash: hash?.() }));
  };
  const onOpenChange = (o: boolean) => {
    if (o && !loaded.current) load(pressed.current ?? { hash: hash?.() });
    if (!o) {
      loaded.current = false;
      pressed.current = undefined;
    }
  };
  const commit = target.hash || undefined;
  return (
    <>
      <ContextMenu.Root onOpenChange={onOpenChange}>
        <ContextMenu.Trigger render={cloneElement(children, { onContextMenuCapture: open, onPointerDownCapture: press, onTouchStartCapture: press, onKeyDownCapture: key })} />
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className={cn(POPUP, "max-w-[calc(100vw-1rem)]")} data-testid="branch-menu">
              {target.ref ? (
                <BranchActions key={target.ref} client={client} cwd={cwd} exact={exact} gitRef={target.ref} host={host} Item={CtxItem} Sep={CtxSep} />
              ) : commit ? (
                <>
                  <CommitItems key={commit} client={client} cwd={cwd} exact={exact} repoName={repoName} hash={commit} busy={busy} onRun={onRun} onReset={host.reset} />
                  <CtxSep />
                  <CtxItem className="max-md:min-h-11" disabled={busy} onClick={() => host.newBranch(commit, short7(commit))} data-testid="branch-new">
                    {t("sidebar.git.newBranch")}
                  </CtxItem>
                </>
              ) : (
                <ContextMenu.Item className={ITEM} disabled data-testid="branch-none">
                  {t("sidebar.git.noLocal")}
                </ContextMenu.Item>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {host.dialogs}
    </>
  );
}

/** One item of a branch action list: the context menu's or the popup's own item component. */
export type MenuItem = ComponentType<{ className?: string; disabled?: boolean; onClick?: () => void; title?: string; "data-testid"?: string; children?: ReactNode }>;
const CtxItem: MenuItem = ({ className, ...p }) => <ContextMenu.Item className={cn(ITEM, className)} {...p} />;
const CtxSep = () => <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />;

/** `git.branch` of a local branch `ref`: `info` once loaded, else `error`. A remote or an unknown ref reads nothing. */
function useBranchInfo(client: Client, cwd: string, exact: boolean, ref: string) {
  const t = useT();
  const [s, setS] = useState<{ info?: GitBranchInfo; error?: string }>({});
  useEffect(() => {
    setS({});
    if (!ref.startsWith("refs/heads/")) return;
    let live = true;
    client.request<GitBranchResult>({ type: "git.branch", cwd, ...(exact && { exact: true as const }), ref }).then(
      (r) => live && setS(r.branch ? { info: r.branch } : { error: t("sidebar.git.notRepo") }),
      (err: RequestError) => live && setS({ error: err.message || t("sidebar.git.failed") }),
    );
    return () => void (live = false);
  }, [client, cwd, exact, ref]);
  return s;
}

/**
 * The actions of one branch `gitRef` (full name), the same in the commit list's chip menu and the branch popup's submenu.
 * What can never work is absent (the current branch has no Checkout, Merge or Rebase); a temporary block is disabled with its reason.
 */
export function BranchActions({ client, cwd, exact = false, gitRef, host, Item, Sep }: { client: Client; cwd: string; exact?: boolean; gitRef: string; host: BranchHost; Item: MenuItem; Sep: ComponentType }) {
  const t = useT();
  const { info, error } = useBranchInfo(client, cwd, exact, gitRef);
  const { busy } = host;
  const remote = gitRef.startsWith("refs/remotes/");
  const x = name(gitRef);
  const cur = info?.headRef ? name(info.headRef) : "HEAD";
  const row = (kind: Kind, label: string, argv: string[] | undefined, why: string | undefined, id: string, danger = false) => (
    <Item className={cn("h-auto min-h-8 flex-col items-start justify-center py-1 max-md:min-h-11", danger && "text-destructive")} disabled={busy || !argv} onClick={() => host.pick(kind, info!)} title={!argv ? why : undefined} data-testid={id}>
      <span>{label}</span>
      {!argv && why && <span className="text-muted-foreground text-xs">{why}</span>}
    </Item>
  );
  const here = info?.checkedOut === "here";
  return (
    <div role="group" aria-label={x}>
      <div className="px-2 pt-1 text-muted-foreground text-xs" data-testid="branch-menu-head">
        <div className="truncate font-medium">{x}</div>
        {info && note(info) && <div>{note(info)}</div>}
      </div>
      {remote && (
        <Item className="max-md:min-h-11" disabled={busy} onClick={() => host.checkout(gitRef)} data-testid="branch-checkout-remote">
          {t("sidebar.git.checkoutRemote")}
        </Item>
      )}
      {!remote && !info && (
        <Item disabled>{error ?? t("sidebar.git.loading")}</Item>
      )}
      {info && (
        <>
          {!here && (
            <Item className="max-md:min-h-11" disabled={busy} onClick={() => host.checkout(gitRef)} data-testid="branch-checkout">
              {t("sidebar.git.checkout")}
            </Item>
          )}
          {row("push", t("sidebar.git.push"), info.push, info.why?.push, "branch-push")}
          {row("force", t("sidebar.git.forcePushMenu"), info.forcePush, info.why?.forcePush, "branch-force-push", true)}
          {row("pull", t("sidebar.git.pull"), info.pull, info.why?.pull, "branch-pull")}
          {!here && (
            <>
              <Sep />
              {row("merge", t("sidebar.git.mergeMenu", { current: cur }), info.merge, info.why?.merge, "branch-merge")}
              {row("rebase", t("sidebar.git.rebaseMenu", { current: cur, branch: x }), info.rebase, info.why?.rebase, "branch-rebase")}
            </>
          )}
        </>
      )}
      <Sep />
      <Item className="max-md:min-h-11" disabled={busy} onClick={() => host.newBranch(gitRef, x)} data-testid="branch-new">
        {t("sidebar.git.newBranchFrom", { from: x })}
      </Item>
    </div>
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
function NewBranchDialog({ from, onCancel, onCreate }: { from: string; onCancel: () => void; onCreate: (name: string, checkout: boolean) => void }) {
  const t = useT();
  const [n, setN] = useState("");
  const [co, setCo] = useState(true);
  const go = () => n.trim() && onCreate(n.trim(), co);
  return (
    <ConfirmDialog open title={t("sidebar.git.newBranchTitle")} description={t("sidebar.git.newBranchText", { from })} confirm={t("sidebar.git.newBranchCreate")} confirmDisabled={!n.trim()} onConfirm={go} onCancel={onCancel} testId="git-new-branch">
      <input autoFocus aria-label={t("sidebar.git.newBranchName")} placeholder={t("sidebar.git.newBranchName")} value={n} onChange={(e) => setN(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), go())} className="h-9 rounded-md border bg-transparent px-2 text-sm max-md:h-11 focus-visible:outline-2 focus-visible:outline-ring" data-testid="git-new-branch-name" />
      <label className="flex items-center gap-2 text-sm max-md:min-h-11">
        <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={co} onChange={(e) => setCo(e.target.checked)} data-testid="git-new-branch-checkout" />
        {t("sidebar.git.newBranchCheckout")}
      </label>
    </ConfirmDialog>
  );
}
