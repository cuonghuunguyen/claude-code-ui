// Create worktree modal (GH-447, docs/spec.md "Worktrees"): a new worktree's branch from a Jira Ticket, an existing Branch or a free Name.
// The daemon creates it (`worktree.create`); errors (a taken folder or branch: `exists`) show here and the modal stays open.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { branchFolder, branchNameError, normalizeBranchName, ticketBranchName, type BranchRow, type JiraSearchResult, type JiraTicket, type SettingsResult, type WorktreeBranchesResult, type WorktreeCreateResult } from "@claude-ui/protocol";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { baseOptions, branchKind, branchWithKey, checkoutRef, filterBranches, folderOf, saveSource, SOURCES, storedSource, type Source } from "./create-worktree.ts";
import { isImeKey } from "./ime.ts";
import { projectName } from "./tabs.ts";

type Props = {
  /** The project whose repository gets the worktree; the modal shows while set. */
  project?: string;
  request: <T>(m: Request) => Promise<T>;
  onClose: () => void;
  /** The worktree is ready: the app opens a new session tab in it. */
  onCreated: (project: string, r: WorktreeCreateResult) => void;
  /** Ticket tab without Jira: opens Settings › Jira. */
  onJiraSettings: () => void;
};

export function CreateWorktreeDialog(p: Props) {
  return p.project !== undefined ? <Body key={p.project} {...p} project={p.project} /> : null;
}

const INPUT = "h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
const SEARCH_DELAY = 300;
type Create = { branch: string; base?: string } | { checkout: string };

function Body({ project, request, onClose, onCreated, onJiraSettings }: Props & { project: string }) {
  const ask = useRef(request);
  ask.current = request;
  const [picked, setPicked] = useState<Source | undefined>(storedSource);
  const [jira, setJira] = useState<{ ready: boolean; template: string }>();
  const source: Source = picked ?? (jira?.ready ? "ticket" : "name");
  const [branches, setBranches] = useState<BranchRow[]>();
  const [defaultBase, setDefaultBase] = useState<string>();
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState<string>();
  const [base, setBase] = useState("");
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [row, setRow] = useState<string>();
  const [query, setQuery] = useState("");
  const [tickets, setTickets] = useState<JiraTicket[]>();
  const [ticketError, setTicketError] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [ticket, setTicket] = useState<JiraTicket>();
  const [ticketText, setTicketText] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const tabRefs = useRef(new Map<Source, HTMLButtonElement>());

  // The local list at once, then again after `git fetch --prune origin` (offline: the local list stays, with a hint).
  useEffect(() => {
    let live = true;
    const apply = (r: WorktreeBranchesResult) => live && (setBranches(r.branches), setDefaultBase(r.defaultBase));
    ask.current<WorktreeBranchesResult>({ type: "worktree.branches", cwd: project }).then(apply, (e: Error) => live && setError(e.message));
    ask.current<WorktreeBranchesResult>({ type: "worktree.branches", cwd: project, fetch: true }).then(
      (r) => (apply(r), live && setFetchError(r.fetchError)),
      () => {},
    ).finally(() => live && setFetching(false));
    ask.current<SettingsResult>({ type: "settings.get" }).then(
      (r) => live && setJira({ ready: !!r.settings.jira?.url && !!r.jiraToken, template: r.settings.jira?.template || "{type}/{key}-{summary}" }),
      () => live && setJira({ ready: false, template: "" }),
    );
    return () => void (live = false);
  }, [project]);

  // Ticket search: my open tickets first, then per typed text (debounced).
  useEffect(() => {
    if (source !== "ticket" || !jira?.ready) return;
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      ask.current<JiraSearchResult>({ type: "jira.search", ...(query.trim() && { text: query.trim() }) }).then(
        (r) => live && (setTickets(r.tickets), setTicketError(undefined)),
        (e: Error) => live && (setTickets(undefined), setTicketError(e.message)),
      ).finally(() => live && setSearching(false));
    }, query ? SEARCH_DELAY : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [source, jira?.ready, query]);

  const choose = (s: Source, focus = false) => {
    setPicked(s);
    saveSource(s);
    setError(undefined);
    if (focus) tabRefs.current.get(s)?.focus();
  };
  const onTabKey = (e: KeyboardEvent) => {
    const at = SOURCES.findIndex((s) => s.id === source);
    const to = e.key === "ArrowRight" ? (at + 1) % SOURCES.length : e.key === "ArrowLeft" ? (at + SOURCES.length - 1) % SOURCES.length : e.key === "Home" ? 0 : e.key === "End" ? SOURCES.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(SOURCES[to]!.id, true);
  };

  const pickTicket = (t: JiraTicket) => {
    setTicket(t);
    setTicketText(ticketBranchName(jira?.template || "{type}/{key}-{summary}", t));
    setError(undefined);
  };
  const newBranch = source === "name" ? normalizeBranchName(name) : source === "ticket" && ticket ? normalizeBranchName(ticketText, { keep: ticket.key }) : "";
  const existing = source === "ticket" && ticket && branches ? branchWithKey(branches, ticket.key) : undefined;
  const selected = source === "branch" ? branches?.find((b) => b.name === row && !b.worktree) : undefined;
  const nameProblem = newBranch ? branchNameError(newBranch) : undefined;
  const plan: Create | undefined = source === "branch" ? (selected ? { checkout: checkoutRef(selected) } : undefined) : newBranch && !nameProblem ? { branch: newBranch, ...(base && { base }) } : undefined;
  const shownBranch = source === "branch" ? selected?.name : newBranch;

  const create = async (req: Create | undefined = plan) => {
    if (!req || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const r = await ask.current<WorktreeCreateResult>({ type: "worktree.create", cwd: project, ...req });
      onCreated(project, r);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };
  const enter = (e: KeyboardEvent<HTMLInputElement>) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), void create());

  const shownRows = useMemo(() => filterBranches(branches ?? [], filter), [branches, filter]);
  const options = useMemo(() => baseOptions(branches ?? []), [branches]);
  const basePicker = (
    <label className="flex flex-col gap-1 text-sm">
      Base
      <select value={base} onChange={(e) => setBase(e.target.value)} className={INPUT} data-testid="create-worktree-base">
        <option value="">Default ({defaultBase ?? "…"})</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const result = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-secondary/50 px-3 py-2 text-xs" data-testid="create-worktree-result">
      <dt className="text-muted-foreground">Branch</dt>
      <dd className="min-w-0 break-all font-mono" data-testid="create-worktree-branch">{shownBranch || "—"}</dd>
      <dt className="text-muted-foreground">Folder</dt>
      <dd className="min-w-0 break-all font-mono" data-testid="create-worktree-folder">{shownBranch ? `.claude/worktrees/${branchFolder(shownBranch)}` : "—"}</dd>
    </dl>
  );
  const hint = nameProblem && <p className="text-destructive text-xs" role="alert" data-testid="create-worktree-problem">{nameProblem}</p>;

  return (
    <ConfigDialog
      title="Create worktree"
      open
      onClose={onClose}
      busy={creating}
      testId="create-worktree"
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{projectName(project)}</span>
          <Button variant="ghost" className="cursor-pointer max-md:h-11" onClick={onClose} disabled={creating} data-testid="create-worktree-cancel">
            Cancel
          </Button>
          <Button className="cursor-pointer max-md:h-11" onClick={() => void create()} disabled={!plan || creating} data-testid="create-worktree-confirm">
            {creating && <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {source === "branch" ? "Check out" : "Create"}
          </Button>
        </>
      }
    >
      <div role="tablist" aria-label="Branch source" onKeyDown={onTabKey} className="flex gap-1 rounded-lg bg-secondary/50 p-1" data-testid="create-worktree-sources">
        {SOURCES.map((s) => (
          <button
            key={s.id}
            ref={(el) => void (el ? tabRefs.current.set(s.id, el) : tabRefs.current.delete(s.id))}
            type="button"
            role="tab"
            id={`create-worktree-tab-${s.id}`}
            aria-selected={s.id === source}
            aria-controls="create-worktree-panel"
            tabIndex={s.id === source ? 0 : -1}
            onClick={() => choose(s.id)}
            className={cn("h-7 flex-1 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11", s.id === source ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
            data-testid={`create-worktree-tab-${s.id}`}
          >
            {s.title}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="create-worktree-panel" aria-labelledby={`create-worktree-tab-${source}`} className="flex flex-col gap-3">
        {source === "name" && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} placeholder="e.g. Fix login" maxLength={200} autoFocus className={INPUT} data-testid="create-worktree-name" />
              <span className="text-muted-foreground text-xs">Lowercase letters, digits, . _ - and /; other characters become -.</span>
            </label>
            {basePicker}
            {result}
            {hint}
          </>
        )}
        {source === "branch" && (
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter branches" aria-label="Filter branches" autoFocus className={INPUT} data-testid="create-worktree-filter" />
            {fetching && <p className="text-muted-foreground text-xs" data-testid="create-worktree-fetching">Fetching from origin…</p>}
            {fetchError && <p className="text-muted-foreground text-xs" data-testid="create-worktree-offline">Could not fetch from origin; showing the branches known locally.</p>}
            <div role="listbox" aria-label="Branches" className="flex max-h-60 flex-col overflow-y-auto rounded-md border" data-testid="create-worktree-branches">
              {!branches && <p className="px-3 py-2 text-muted-foreground text-sm">Loading…</p>}
              {branches && !shownRows.length && <p className="px-3 py-2 text-muted-foreground text-sm">No branches</p>}
              {shownRows.map((b) => (
                <button
                  key={b.name}
                  type="button"
                  role="option"
                  aria-selected={b.name === row}
                  aria-disabled={!!b.worktree}
                  onClick={() => !b.worktree && (setRow(b.name), setError(undefined))}
                  onDoubleClick={() => !b.worktree && void create({ checkout: checkoutRef(b) })}
                  className={cn("flex min-h-8 items-center gap-2 px-3 py-1 text-left text-sm outline-none focus-visible:bg-accent max-md:min-h-11", b.name === row ? "bg-accent" : "hover:bg-accent/60", b.worktree && "cursor-default text-muted-foreground")}
                  data-testid="create-worktree-branch-row"
                  data-name={b.name}
                >
                  <span className="min-w-12 flex-1 truncate font-mono">{b.name}</span>
                  <span className="min-w-0 max-w-[55%] truncate text-muted-foreground text-xs" title={b.worktree}>{b.worktree ? `in worktree ${folderOf(b.worktree)}` : branchKind(b)}</span>
                </button>
              ))}
            </div>
            {result}
          </>
        )}
        {source === "ticket" &&
          (!jira ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : !jira.ready ? (
            <p className="text-sm" data-testid="create-worktree-no-jira">
              Jira is not set up.{" "}
              <button type="button" onClick={onJiraSettings} className="text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" data-testid="create-worktree-jira-settings">
                Open Settings › Jira
              </button>
            </p>
          ) : (
            <>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Key, text or ticket URL" aria-label="Search tickets" autoFocus className={INPUT} data-testid="create-worktree-ticket-search" />
              {ticketError && <Banner kind="error">{ticketError}</Banner>}
              <div role="listbox" aria-label="Tickets" className="flex max-h-48 flex-col overflow-y-auto rounded-md border" data-testid="create-worktree-tickets">
                {searching && !tickets && <p className="px-3 py-2 text-muted-foreground text-sm">Searching…</p>}
                {tickets && !tickets.length && <p className="px-3 py-2 text-muted-foreground text-sm">{query.trim() ? "No tickets found" : "No open tickets assigned to you"}</p>}
                {tickets?.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    role="option"
                    aria-selected={t.key === ticket?.key}
                    onClick={() => pickTicket(t)}
                    className={cn("flex min-h-8 items-center gap-2 px-3 py-1 text-left text-sm outline-none focus-visible:bg-accent max-md:min-h-11", t.key === ticket?.key ? "bg-accent" : "hover:bg-accent/60")}
                    data-testid="create-worktree-ticket-row"
                    data-key={t.key}
                  >
                    <span className="shrink-0 font-mono text-xs">{t.key}</span>
                    <span className="shrink-0 text-muted-foreground text-xs max-sm:hidden">{t.type}</span>
                    <span className="min-w-0 flex-1 truncate">{t.summary}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">{t.status}</span>
                  </button>
                ))}
              </div>
              {ticket && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    Branch name
                    <input value={ticketText} onChange={(e) => setTicketText(e.target.value)} onKeyDown={enter} maxLength={200} className={INPUT} data-testid="create-worktree-ticket-branch" />
                  </label>
                  {existing && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm" data-testid="create-worktree-existing">
                      <span className="min-w-0 flex-1">
                        Branch <span className="break-all font-mono">{existing.name}</span> already has {ticket.key}
                        {existing.worktree ? ` (in worktree ${folderOf(existing.worktree)})` : ""}.
                      </span>
                      {!existing.worktree && (
                        <Button variant="outline" size="sm" className="cursor-pointer max-md:h-11" disabled={creating} onClick={() => void create({ checkout: checkoutRef(existing) })} data-testid="create-worktree-checkout-existing">
                          Check out {existing.name}
                        </Button>
                      )}
                    </div>
                  )}
                  {basePicker}
                  {result}
                  {hint}
                </>
              )}
            </>
          ))}
        {error && <Banner kind="error">{error}</Banner>}
      </div>
    </ConfigDialog>
  );
}
