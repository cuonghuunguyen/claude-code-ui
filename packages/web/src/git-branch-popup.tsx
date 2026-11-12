// Branch popup of the Graph tab (docs/spec.md "Layout", Graph tab; IntelliJ parity): speed search over All branches, HEAD, Local and Remote;
// click or Enter filters the graph; mouse hover, `›` or ArrowRight opens the branch actions (the same component as the chip's context menu).
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { GitBranchResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { usePanelAsk, type BranchAskAction } from "./panel-ask.ts";
import { BranchActions, useBranchHost, type BranchHost, type MenuItem } from "./git-branch-menu.tsx";
import { POPUP } from "./session-actions.tsx";
import { useT } from "./i18n.ts";

type Client = ReturnType<typeof connect>;
type Row = { id: string; kind: "all" | "head" | "local" | "remote" | "remotes" | "title"; value: string; label: string };
const short = (ref: string) => ref.replace(/^refs\/(heads|remotes|tags)\//, "");
const isNav = (r: Row) => r.kind !== "title";
/** GH-722: a branch pick started by a palette command; "new" has no pick (it opens the New branch dialog at once). */
type Pick = Exclude<BranchAskAction, "new">;
const PICK_TEXT = { checkout: "app.cmd.pickCheckout", checkoutSmart: "app.cmd.pickCheckoutSmart", merge: "app.cmd.pickMerge", rebase: "app.cmd.pickRebase" } as const;

const PopItem: MenuItem = ({ className, disabled, onClick, children, ...p }) => (
  <button type="button" role="menuitem" aria-disabled={disabled || undefined} onClick={disabled ? undefined : onClick} className={cn("flex h-8 w-full cursor-pointer select-none items-center rounded-md px-2 text-left outline-none hover:bg-secondary focus-visible:bg-secondary aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:bg-transparent max-md:h-11", className)} {...p}>
    {children}
  </button>
);
const PopSep = () => <div role="separator" className="-mx-1 my-1 h-px bg-border" />;

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-[color-mix(in_srgb,var(--ref-head)_35%,transparent)] font-semibold text-inherit" data-testid="branch-popup-match">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/**
 * `value`: "all", "HEAD" or a full ref (the Graph's branch filter); `branches`: full ref names, `head`: the current branch's full ref.
 * `headLabel`: the HEAD row's text ("HEAD (main)"); `label`: the trigger's text.
 */
export function BranchPopup({ client, cwd, exact = false, repoName, busy, onRun, branches, head, value, label, headLabel, allLabel, onChange }: { client: Client; cwd: string; exact?: boolean; repoName?: string; busy: boolean; onRun: Parameters<typeof useBranchHost>[0]["onRun"]; branches: string[]; head?: string; value: string; label: string; headLabel: string; allLabel: string; onChange: (value: string) => void }) {
  const t = useT();
  const host = useBranchHost({ client, cwd, exact, repoName, busy, onRun });
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [subRaw, setSubRaw] = useState<string>();
  // GH-722: a pick (palette Checkout, Smart checkout, Merge, Rebase) lists the branches to pick, with no actions submenu.
  const [pick, setPick] = useState<Pick>();
  const [pickNote, setPickNote] = useState<string>();
  const sub = pick ? undefined : subRaw;
  const setSub = (v: string | undefined) => void (!pick && setSubRaw(v));
  const input = useRef<HTMLInputElement>(null);
  const subEl = useRef<HTMLDivElement>(null);
  // Hover opens the actions without moving focus, so typing stays in the search box.
  const hovered = useRef(false);
  const needle = q.trim();
  const rows = useMemo<Row[]>(() => {
    const ok = (l: string) => !needle || l.toLowerCase().includes(needle.toLowerCase());
    const out: Row[] = [];
    if (pick) {
      // The current branch is not offered; Merge and Rebase take a local branch (the menu offers them for local branches only).
      const pickable = (b: string) => b !== head && ok(short(b));
      const local = branches.filter((b) => b.startsWith("refs/heads/") && pickable(b));
      if (local.length) out.push({ id: "t-local", kind: "title", value: "", label: t("files.graph.local") }, ...local.map((b) => ({ id: b, kind: "local" as const, value: b, label: short(b) })));
      const remote = pick === "checkout" || pick === "checkoutSmart" ? branches.filter((b) => b.startsWith("refs/remotes/") && !b.endsWith("/HEAD") && pickable(b)) : [];
      if (remote.length) out.push({ id: "t-remote", kind: "title", value: "", label: t("files.graph.remote") }, ...remote.map((b) => ({ id: b, kind: "remote" as const, value: b, label: short(b) })));
      return out;
    }
    if (ok(allLabel)) out.push({ id: "all", kind: "all", value: "all", label: allLabel });
    if (ok(headLabel)) out.push({ id: "HEAD", kind: "head", value: "HEAD", label: headLabel });
    const local = branches.filter((b) => b.startsWith("refs/heads/") && ok(short(b)));
    if (local.length) out.push({ id: "t-local", kind: "title", value: "", label: t("files.graph.local") }, ...local.map((b) => ({ id: b, kind: "local" as const, value: b, label: short(b) })));
    const remote = branches.filter((b) => b.startsWith("refs/remotes/") && !b.endsWith("/HEAD") && ok(short(b)));
    if (remote.length) {
      // A search expands the group; without one it stays collapsed.
      out.push({ id: "remotes", kind: needle ? "title" : "remotes", value: "", label: t("files.graph.remote") });
      if (needle || remotesOpen) out.push(...remote.map((b) => ({ id: b, kind: "remote" as const, value: b, label: short(b) })));
    }
    return out;
  }, [branches, needle, remotesOpen, allLabel, headLabel, t, pick, head]);
  // The HEAD row offers the actions of the current branch (none when detached).
  const refOf = (r?: Row) => (r?.kind === "head" ? head : r?.kind === "local" || r?.kind === "remote" ? r.value : undefined);
  const nav = rows.filter(isNav);
  const cur = nav[Math.min(active, nav.length - 1)];
  useEffect(() => setActive(0), [needle, open]);
  useEffect(() => {
    if (open) document.getElementById(`bp-${cur?.id}`)?.scrollIntoView?.({ block: "nearest" });
  }, [cur?.id, open]);
  useEffect(() => {
    if (sub && !hovered.current) subEl.current?.querySelector<HTMLElement>("[role=menuitem]:not([aria-disabled])")?.focus();
  }, [sub]);
  const close = () => (setOpen(false), setQ(""), setSubRaw(undefined), setPick(undefined), setPickNote(undefined));
  // Picked branch: Checkout runs at once; Merge and Rebase read the branch first (their command and the reason one is blocked).
  const pickBranch = (ref: string) => {
    if (host.busy || !pick) return;
    if (pick === "checkout" || pick === "checkoutSmart") return (close(), host.checkout(ref, pick === "checkoutSmart"));
    const kind = pick;
    setPickNote(undefined);
    client.request<GitBranchResult>({ type: "git.branch", cwd, ...(exact && { exact: true as const }), ref }).then(
      (r) => {
        const info = r.branch;
        if (!info) return setPickNote(t("sidebar.git.notRepo"));
        if (!info[kind]) return setPickNote(info.why?.[kind] ?? t("sidebar.git.failed"));
        close();
        host.pick(kind, info);
      },
      (e: RequestError) => setPickNote(e.message || t("sidebar.git.failed")),
    );
  };
  // GH-722: the palette's branch commands (panel-ask.ts).
  usePanelAsk("branch", (a) => {
    if (a.action === "new") return void host.newBranch(undefined, head ? short(head) : "HEAD");
    setPickNote(undefined);
    setPick(a.action);
    setSubRaw(undefined);
    setQ("");
    setOpen(true);
  });
  const choose = (r: Row) => {
    if (pick && (r.kind === "local" || r.kind === "remote")) return pickBranch(r.value);
    if (r.kind === "remotes") return setRemotesOpen((o) => !o);
    onChange(r.value);
    close();
  };
  // Choosing an action closes the popup; its dialog is rendered by the popup's host, outside the popup.
  const subHost: BranchHost = { ...host, checkout: (r) => (close(), host.checkout(r)), pick: (k, i) => (close(), host.pick(k, i)), newBranch: (a, l) => (close(), host.newBranch(a, l)) };
  const onOpenChange = (o: boolean, d?: { reason?: string }) => {
    if (o) return setOpen(true);
    // Esc: first the submenu, then the query, then the popup. An outside press or a focus loss closes at once.
    if (d?.reason === "escape-key") {
      if (sub) return (setSub(undefined), input.current?.focus());
      if (q) return setQ("");
    }
    close();
  };
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const atEnd = e.currentTarget.selectionStart === e.currentTarget.value.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, Math.min(nav.length - 1, (Math.min(i, nav.length - 1)) + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter" && cur) {
      e.preventDefault();
      choose(cur);
    } else if (e.key === "ArrowRight" && cur && atEnd) {
      e.preventDefault();
      if (refOf(cur)) (hovered.current = false), setSub(refOf(cur));
      else if (cur.kind === "remotes") setRemotesOpen(true);
    } else if (e.key === "ArrowLeft" && sub) {
      e.preventDefault();
      setSub(undefined);
    }
  };
  // IntelliJ speed search: a printable key anywhere in the popup goes to the box.
  const onPopupKey = (e: React.KeyboardEvent) => {
    if (e.target === input.current || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    if (e.key === " " && (e.target as HTMLElement).tagName === "BUTTON") return;
    // Below md the actions replace the list and the box: back to the list with the key typed.
    if (input.current && !input.current.offsetParent && sub) {
      e.preventDefault();
      setSub(undefined);
      setQ((v) => v + e.key);
      setTimeout(() => input.current?.focus());
      return;
    }
    input.current?.focus();
  };
  const onSubKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setSub(undefined);
      input.current?.focus();
      return;
    }
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const items = [...subEl.current!.querySelectorAll<HTMLElement>("[role=menuitem]:not([aria-disabled])")];
    items[(items.indexOf(document.activeElement as HTMLElement) + d + items.length) % items.length]?.focus();
  };
  const subRow = rows.find((r) => sub !== undefined && refOf(r) === sub);
  return (
    <>
      <Popover.Root open={open} onOpenChange={onOpenChange}>
        <Popover.Trigger aria-label={t("files.graph.branch")} className="flex h-8 max-w-44 items-center justify-between gap-1 rounded-md bg-secondary/60 px-2 text-sm outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" data-testid="graph-filter-branch">
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="start" sideOffset={4} className="z-50">
            <Popover.Popup initialFocus={input} className={cn(POPUP, "flex max-h-[min(24rem,var(--available-height))] max-w-[calc(100vw-1rem)] gap-1 p-1", sub ? "md:w-[34rem]" : "w-72")} onKeyDown={onPopupKey} data-testid="branch-popup">
              <div className={cn("flex min-h-0 w-72 max-w-full flex-1 flex-col", sub && "max-md:hidden")}>
                {pick && <p className="mb-1 px-2 font-medium text-xs" data-testid="branch-popup-pick">{t(PICK_TEXT[pick])}</p>}
                {pickNote && <p className="mb-1 px-2 text-muted-foreground text-xs" role="alert" data-testid="branch-popup-pick-note">{pickNote}</p>}
                <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onInputKey} role="combobox" aria-expanded aria-controls="bp-list" aria-activedescendant={cur ? `bp-${cur.id}` : undefined} aria-label={t("files.graph.searchBranches")} placeholder={t("files.graph.searchBranches")} className="mb-1 h-8 w-full shrink-0 rounded-md bg-secondary/60 px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" data-testid="branch-popup-search" />
                <div id="bp-list" role="listbox" aria-label={t("files.graph.branch")} className="min-h-0 flex-1 overflow-y-auto">
                  {rows.map((r) =>
                    r.kind === "title" ? (
                      <div key={r.id} className="px-2 pt-1 font-medium text-muted-foreground text-xs">{r.label}</div>
                    ) : (
                      <div key={r.id} id={`bp-${r.id}`} role={r.kind === "remotes" ? "button" : "option"} aria-selected={r.kind === "remotes" ? undefined : r.value === value} aria-expanded={r.kind === "remotes" ? needle !== "" || remotesOpen : undefined} onClick={() => choose(r)} onPointerEnter={(e) => e.pointerType === "mouse" && sub !== refOf(r) && ((hovered.current = true), setSub(refOf(r)))} className={cn("group/row flex h-8 cursor-pointer select-none items-center gap-1 rounded-md pr-0.5 pl-2 hover:bg-secondary max-md:min-h-11", r === cur && "bg-secondary", r.kind === "remotes" && "font-medium text-muted-foreground text-xs")} data-testid="branch-popup-row" data-ref={r.kind === "head" ? undefined : refOf(r)}>
                        {r.kind === "remotes" && <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", (needle || remotesOpen) && "rotate-90")} aria-hidden />}
                        <span className="min-w-0 flex-1 truncate"><Highlight text={r.label} q={needle} /></span>
                        {r.kind === "local" && r.value === head && <CheckIcon className="size-4 shrink-0 text-ref-head" aria-label={t("files.graph.currentBranch")} data-testid="branch-popup-current" />}
                        {refOf(r) && (
                          <button type="button" tabIndex={-1} aria-label={t("files.graph.branchActions", { branch: r.label })} onClick={(e) => (e.stopPropagation(), (hovered.current = false), setSub(refOf(r)))} className={cn("flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent group-hover/row:opacity-100 max-md:size-11 max-md:opacity-100", r === cur && "opacity-100")} data-testid="branch-popup-more">
                            <ChevronRightIcon className="size-4" aria-hidden />
                          </button>
                        )}
                      </div>
                    ),
                  )}
                  {!rows.length && <p className="px-2 py-1 text-muted-foreground">{t("files.graph.noBranch")}</p>}
                </div>
              </div>
              {sub && subRow && (
                <div ref={subEl} role="menu" aria-label={subRow.label} onKeyDown={onSubKey} className="flex w-72 max-w-full flex-1 flex-col overflow-y-auto md:w-60 md:flex-none md:border-l md:pl-1" data-testid="branch-popup-sub">
                  <button type="button" onClick={() => (setSub(undefined), input.current?.focus())} className="flex h-11 shrink-0 items-center rounded-md px-2 text-left text-sm hover:bg-secondary md:hidden">‹ {t("files.graph.branch")}</button>
                  <BranchActions key={sub} client={client} cwd={cwd} exact={exact} gitRef={sub} host={subHost} Item={PopItem} Sep={PopSep} />
                </div>
              )}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {host.dialogs}
    </>
  );
}
