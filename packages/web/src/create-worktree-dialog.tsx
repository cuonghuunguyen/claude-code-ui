// Create worktree modal (GH-447, docs/spec.md "Worktrees"): a new worktree's branch from a Jira Ticket, an existing Branch or a free Name.
// The daemon creates it (`worktree.create`); errors (a taken folder or branch: `exists`) show here and the modal stays open.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { branchNameError, checkoutFolder, checkoutFolderError, normalizeBranchName, ticketBranchName, type BranchRow, jiraKeyInBranch, type JiraSearchResult, type JiraTicket, type PullRequestBranchesResult, type SettingsResult, type WorktreeBranchesResult, type WorktreeCreateResult } from "@claude-ui/protocol";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { baseOptions, branchesWithKey, branchKind, branchWithKey, checkoutRef, pasteOf, filterBranches, folderOf, saveSource, SOURCES, storedSource, type Source } from "./create-worktree.ts";
import { isImeKey } from "./ime.ts";
import { projectName } from "./tabs.ts";
import { useT } from "./i18n.ts";

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
  const t = useT();
  const ask = useRef(request);
  ask.current = request;
  const [picked, setPicked] = useState<Source | undefined>(storedSource);
  const [jira, setJira] = useState<{ ready: boolean; template: string; filter: boolean }>();
  const source: Source = picked ?? (jira?.ready ? "ticket" : "name");
  const [branches, setBranches] = useState<BranchRow[]>();
  const [defaultBase, setDefaultBase] = useState<string>();
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState<string>();
  const [base, setBase] = useState("");
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [row, setRow] = useState<string>();
  /** The Branch filter's pull request link, looked up: its origin branches, or the error. */
  const [pr, setPr] = useState<{ url: string; result?: PullRequestBranchesResult; error?: string }>();
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
    let fetched = false; // the fetched list never gives way to a plain one that arrives later
    const apply = (r: WorktreeBranchesResult) => live && (setBranches(r.branches), setDefaultBase(r.defaultBase));
    ask.current<WorktreeBranchesResult>({ type: "worktree.branches", cwd: project }).then((r) => fetched || apply(r), (e: Error) => live && setError(e.message));
    ask.current<WorktreeBranchesResult>({ type: "worktree.branches", cwd: project, fetch: true }).then(
      (r) => ((fetched = true), apply(r), live && setFetchError(r.fetchError)),
      () => {},
    ).finally(() => live && setFetching(false));
    ask.current<SettingsResult>({ type: "settings.get" }).then(
      (r) => live && setJira({ ready: !!r.settings.jira?.url && !!r.jiraToken, template: r.settings.jira?.template || "{type}/{key}-{summary}", filter: !!r.settings.jira?.jql?.trim() }),
      () => live && setJira({ ready: false, template: "", filter: false }),
    );
    return () => void (live = false);
  }, [project]);

  // Ticket search: my open tickets first, then per typed text (debounced).
  useEffect(() => {
    if (source !== "ticket" || !jira?.ready) return;
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      // A pull request link: the ticket its branch names.
      const paste = pasteOf(query);
      const text =
        paste.kind === "pr"
          ? ask.current<PullRequestBranchesResult>({ type: "worktree.pr", cwd: project, url: paste.url }).then((r) => {
              const key = r.branches.map(jiraKeyInBranch).find(Boolean);
              if (!key) throw new Error(r.branches.length ? t("sidebar.cw.prNoTicket", { number: r.number, branches: r.branches.join(", ") }) : t("sidebar.cw.prNoBranch", { number: r.number }));
              return key;
            })
          : Promise.resolve(query.trim());
      text.then((q) => ask.current<JiraSearchResult>({ type: "jira.search", ...(q && { text: q }) })).then(
        (r) => live && (setTickets(r.tickets), setTicketError(undefined)),
        (e: Error) => live && (setTickets(undefined), setTicketError(e.message)),
      ).finally(() => live && setSearching(false));
    }, query ? SEARCH_DELAY : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [source, jira?.ready, query, project]);

  // Branch filter: a pasted pull request link is looked up on origin (debounced like the ticket search).
  const paste = useMemo(() => pasteOf(filter), [filter]);
  const prUrl = source === "branch" && paste.kind === "pr" ? paste.url : undefined;
  useEffect(() => {
    if (!prUrl) return;
    let live = true;
    setPr({ url: prUrl });
    const timer = setTimeout(() => {
      ask.current<PullRequestBranchesResult>({ type: "worktree.pr", cwd: project, url: prUrl }).then(
        (result) => live && setPr({ url: prUrl, result }),
        (e: Error) => live && setPr({ url: prUrl, error: e.message }),
      );
    }, SEARCH_DELAY);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [prUrl, project]);

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

  const pickTicket = (tk: JiraTicket) => {
    setTicket(tk);
    setTicketText(ticketBranchName(jira?.template || "{type}/{key}-{summary}", tk));
    setError(undefined);
  };
  const newBranch = source === "name" ? normalizeBranchName(name) : source === "ticket" && ticket ? normalizeBranchName(ticketText, { keep: ticket.key }) : "";
  const existing = source === "ticket" && ticket && branches ? branchWithKey(branches, ticket.key) : undefined;
  const selected = source === "branch" ? branches?.find((b) => b.name === row && !b.worktree) : undefined;
  const nameProblem = newBranch ? branchNameError(newBranch) : undefined;
  const checkoutProblem = selected ? checkoutFolderError(selected.name) : undefined;
  const plan: Create | undefined = source === "branch" ? (selected && !checkoutProblem ? { checkout: checkoutRef(selected) } : undefined) : newBranch && !nameProblem ? { branch: newBranch, ...(base && { base }) } : undefined;
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

  const prNow = prUrl && pr?.url === prUrl ? pr : undefined;
  const shownRows = useMemo(() => {
    const rows = branches ?? [];
    if (paste.kind === "pr") return prNow?.result ? rows.filter((r) => prNow.result!.branches.includes(r.name)) : [];
    if (paste.kind === "key") return branchesWithKey(rows, paste.key);
    return filterBranches(rows, filter);
  }, [branches, filter, paste, prNow]);
  // A pasted link or key that matches one free branch selects it.
  const only = paste.kind !== "words" && shownRows.length === 1 && !shownRows[0]!.worktree ? shownRows[0]!.name : undefined;
  useEffect(() => void (only && setRow(only)), [only]);
  const prNote = !prNow
    ? undefined
    : prNow.error
      ? { error: true, text: prNow.error }
      : !prNow.result
        ? { error: false, text: t("sidebar.cw.prLooking") }
        : !prNow.result.branches.length
          ? { error: false, text: t("sidebar.cw.prGone", { number: prNow.result.number }) }
          : { error: false, text: `${t("sidebar.cw.prBranches", { number: prNow.result.number, branches: prNow.result.branches.join(", ") })}${prNow.result.branches.some((b) => !branches?.some((r) => r.name === b)) ? t("sidebar.cw.prNotFetched") : ""}` };
  const options = useMemo(() => baseOptions(branches ?? []), [branches]);
  const baseLabel = (v: string | null) => (v ? (options.find((o) => o.value === v)?.label ?? v) : t("sidebar.cw.baseDefault", { base: defaultBase ?? "…" }));
  const basePicker = (
    <div className="flex flex-col gap-1 text-sm">
      <span id="create-worktree-base-label">{t("sidebar.cw.base")}</span>
      <Select value={base} onValueChange={(v) => setBase(v ?? "")}>
        <SelectTrigger aria-labelledby="create-worktree-base-label" className="w-full min-w-0 data-[size=default]:h-8 max-md:data-[size=default]:h-11" data-testid="create-worktree-base">
          <SelectValue className="min-w-0 truncate">{baseLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false} className="max-h-72">
          {[{ value: "", label: baseLabel(null) }, ...options].map((o) => (
            <SelectItem key={o.value} value={o.value} data-testid={`create-worktree-base-${o.value || "default"}`} className="max-md:min-h-11">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  // A path, not a word of a language.
  const folderPath = shownBranch ? `.claude/worktrees/${checkoutFolder(shownBranch)}` : "—";
  const result = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-secondary/50 px-3 py-2 text-xs" data-testid="create-worktree-result">
      <dt className="text-muted-foreground">{t("sidebar.cw.branch")}</dt>
      <dd className="min-w-0 break-all font-mono" data-testid="create-worktree-branch">{shownBranch || "—"}</dd>
      <dt className="text-muted-foreground">{t("sidebar.cw.folder")}</dt>
      <dd className="min-w-0 break-all font-mono" data-testid="create-worktree-folder">{folderPath}</dd>
    </dl>
  );
  const hint = (nameProblem ?? checkoutProblem) && <p className="text-destructive text-xs" role="alert" data-testid="create-worktree-problem">{nameProblem ?? checkoutProblem}</p>;

  return (
    <ConfigDialog
      title={t("sidebar.cw.title")}
      open
      onClose={onClose}
      busy={creating}
      testId="create-worktree"
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{projectName(project)}</span>
          <Button variant="ghost" className="cursor-pointer max-md:h-11" onClick={onClose} disabled={creating} data-testid="create-worktree-cancel">
            {t("sidebar.cancel")}
          </Button>
          <Button className="cursor-pointer max-md:h-11" onClick={() => void create()} disabled={!plan || creating} data-testid="create-worktree-confirm">
            {creating && <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" aria-hidden />}
            {t(source === "branch" ? "sidebar.cw.checkOut" : "sidebar.cw.create")}
          </Button>
        </>
      }
    >
      <div role="tablist" aria-label={t("sidebar.cw.sourceAria")} onKeyDown={onTabKey} className="flex gap-1 rounded-lg bg-secondary/50 p-1" data-testid="create-worktree-sources">
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
            {t(s.title)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="create-worktree-panel" aria-labelledby={`create-worktree-tab-${source}`} className="flex flex-col gap-3">
        {source === "name" && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              {t("sidebar.cw.name")}
              <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={enter} placeholder={t("sidebar.cw.namePlaceholder")} maxLength={200} autoFocus className={INPUT} data-testid="create-worktree-name" />
              <span className="text-muted-foreground text-xs">{t("sidebar.cw.nameHelp")}</span>
            </label>
            {basePicker}
            {result}
            {hint}
          </>
        )}
        {source === "branch" && (
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("sidebar.cw.filterPlaceholder")} aria-label={t("sidebar.cw.filterAria")} autoFocus className={INPUT} data-testid="create-worktree-filter" />
            {prNote && (
              <p role={prNote.error ? "alert" : "status"} className={cn("text-xs", prNote.error ? "text-destructive" : "text-muted-foreground")} data-testid="create-worktree-pr">
                {prNote.text}
              </p>
            )}
            {fetching && <p className="text-muted-foreground text-xs" data-testid="create-worktree-fetching">{t("sidebar.cw.fetching")}</p>}
            {fetchError && <p className="text-muted-foreground text-xs" data-testid="create-worktree-offline">{t("sidebar.cw.offline")}</p>}
            <div role="listbox" aria-label={t("sidebar.cw.branches")} className="flex max-h-60 flex-col overflow-y-auto rounded-md border" data-testid="create-worktree-branches">
              {!branches && <p className="px-3 py-2 text-muted-foreground text-sm">{t("sidebar.cw.loading")}</p>}
              {branches && !shownRows.length && !(prNow && !prNow.result) && <p className="px-3 py-2 text-muted-foreground text-sm">{t("sidebar.cw.noBranches")}</p>}
              {shownRows.map((b) => (
                <button
                  key={b.name}
                  type="button"
                  role="option"
                  aria-selected={b.name === row}
                  aria-disabled={!!b.worktree}
                  onClick={() => !b.worktree && (setRow(b.name), setError(undefined))}
                  onDoubleClick={() => !b.worktree && !checkoutFolderError(b.name) && void create({ checkout: checkoutRef(b) })}
                  className={cn("flex min-h-8 items-center gap-2 px-3 py-1 text-left text-sm outline-none focus-visible:bg-accent max-md:min-h-11", b.name === row ? "bg-accent" : "hover:bg-accent/60", b.worktree && "cursor-default text-muted-foreground")}
                  data-testid="create-worktree-branch-row"
                  data-name={b.name}
                >
                  <span className="min-w-12 flex-1 truncate font-mono">{b.name}</span>
                  <span className="min-w-0 max-w-[55%] truncate text-muted-foreground text-xs" title={b.worktree}>{b.worktree ? t("sidebar.cw.inWorktree", { name: folderOf(b.worktree) }) : branchKind(b)}</span>
                </button>
              ))}
            </div>
            {hint}
            {result}
          </>
        )}
        {source === "ticket" &&
          (!jira ? (
            <p className="text-muted-foreground text-sm">{t("sidebar.cw.loading")}</p>
          ) : !jira.ready ? (
            <p className="text-sm" data-testid="create-worktree-no-jira">
              {t("sidebar.cw.noJira")}{" "}
              <button type="button" onClick={onJiraSettings} className="text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" data-testid="create-worktree-jira-settings">
                {t("sidebar.cw.openJira")}
              </button>
            </p>
          ) : (
            <>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("sidebar.cw.ticketPlaceholder")} aria-label={t("sidebar.cw.searchTickets")} autoFocus className={INPUT} data-testid="create-worktree-ticket-search" />
              {ticketError && <Banner kind="error">{ticketError}</Banner>}
              <div role="listbox" aria-label={t("sidebar.cw.tickets")} className="flex max-h-48 flex-col overflow-y-auto rounded-md border" data-testid="create-worktree-tickets">
                {searching && !tickets && <p className="px-3 py-2 text-muted-foreground text-sm">{t("sidebar.cw.searching")}</p>}
                {tickets && !tickets.length && <p className="px-3 py-2 text-muted-foreground text-sm">{t(query.trim() ? "sidebar.cw.noTickets" : jira.filter ? "sidebar.cw.noTicketsFilter" : "sidebar.cw.noTicketsOpen")}</p>}
                {tickets?.map((tk) => (
                  <button
                    key={tk.key}
                    type="button"
                    role="option"
                    aria-selected={tk.key === ticket?.key}
                    onClick={() => pickTicket(tk)}
                    className={cn("flex min-h-8 items-center gap-2 px-3 py-1 text-left text-sm outline-none focus-visible:bg-accent max-md:min-h-11", tk.key === ticket?.key ? "bg-accent" : "hover:bg-accent/60")}
                    data-testid="create-worktree-ticket-row"
                    data-key={tk.key}
                  >
                    <span className="shrink-0 font-mono text-xs">{tk.key}</span>
                    <span className="shrink-0 text-muted-foreground text-xs max-sm:hidden">{tk.type}</span>
                    <span className="min-w-0 flex-1 truncate">{tk.summary}</span>
                    <span className="shrink-0 text-muted-foreground text-xs">{tk.status}</span>
                  </button>
                ))}
              </div>
              {ticket && (
                <>
                  <label className="flex flex-col gap-1 text-sm">
                    {t("sidebar.cw.branchName")}
                    <input value={ticketText} onChange={(e) => setTicketText(e.target.value)} onKeyDown={enter} maxLength={200} className={INPUT} data-testid="create-worktree-ticket-branch" />
                  </label>
                  {existing && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm" data-testid="create-worktree-existing">
                      <span className="min-w-0 flex-1">
                        {t("sidebar.cw.existing", { name: existing.name, key: ticket.key, where: existing.worktree ? t("sidebar.cw.existingWhere", { name: folderOf(existing.worktree) }) : "" })}
                      </span>
                      {!existing.worktree && (
                        <Button variant="outline" size="sm" className="cursor-pointer max-md:h-11" disabled={creating} onClick={() => void create({ checkout: checkoutRef(existing) })} data-testid="create-worktree-checkout-existing">
                          {t("sidebar.cw.checkOutNamed", { name: existing.name })}
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
