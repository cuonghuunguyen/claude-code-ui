// "Manage Plugins" dialog (/plugins), a copy of the Claude Code VS Code extension 2.1.283's: tab Plugins (installed with switch,
// Update, Uninstall, MCP chips; available with search and Install behind the scope picker), tab Marketplaces. Logic in plugins.ts.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { BadgeCheckIcon, RefreshCwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type {
  AvailablePlugin,
  InstalledPlugin,
  MarketplaceInfo,
  McpListResult,
  McpServerInfo,
  PluginsListResult,
  PluginUpdateFailure,
  PluginUpdateResult,
  PluginWriteResult,
  ReloadResult,
} from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { trapTab } from "./focus-trap.ts";
import { chipOf, failureDialog, filterAvailable, formatInstalls, INSTALL_SCOPES, marketplaceLink, marketplaceOf, marketplaceText, TRUST_WARNING, updateNotice, type FailureAction } from "./plugins.ts";

type Failure = { plugin: InstalledPlugin; kind: PluginUpdateFailure; message: string };

/**
 * `cwd`: the project of the shown tab; `sessionId`: the shown session (its MCP status feeds the chips; Restart restarts it).
 * `changed`: bumped on `config.changed` for `cwd`. `reloadFailed`: the shown session's last plugin reload failed (restart banner).
 * `onRestarted`: sessions whose query was restarted (no longer failed).
 */
export function PluginsDialog({
  open,
  cwd,
  sessionId,
  changed = 0,
  reloadFailed,
  request,
  onRestarted,
  onClose,
}: {
  open: boolean;
  cwd: string;
  sessionId?: string;
  changed?: number;
  reloadFailed?: boolean;
  request: <T>(msg: Request) => Promise<T>;
  onRestarted: (sessionIds: string[]) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"plugins" | "marketplaces">("plugins");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [available, setAvailable] = useState<AvailablePlugin[]>([]);
  const [marketplaces, setMarketplaces] = useState<MarketplaceInfo[]>([]);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [picking, setPicking] = useState<string>();
  const [updating, setUpdating] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<Failure>();
  // Sessions whose reload after this dialog's own change failed: the "Reload plugins" dialog.
  const [failedReload, setFailedReload] = useState<string[]>();
  const [source, setSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string>();
  const [confirmRemove, setConfirmRemove] = useState<string>();

  const ask = useRef(request);
  ask.current = request;
  const where = useRef({ cwd, sessionId });
  where.current = { cwd, sessionId };
  const sent = useRef(0);
  /** Lists plugins and marketplaces (one CLI call each) and the MCP status for the chips; a newer answer wins. */
  const load = async () => {
    const n = ++sent.current;
    const { cwd, sessionId } = where.current;
    const mcp = ask.current<McpListResult>({ type: "mcp.list", cwd, ...(sessionId && { sessionId }) }).catch(() => undefined);
    try {
      const r = await ask.current<PluginsListResult>({ type: "plugins.list", cwd });
      if (n !== sent.current) return;
      setInstalled(r.installed);
      setAvailable(r.available);
      setMarketplaces(r.marketplaces);
      setLoadError(undefined);
    } catch (e) {
      if (n === sent.current) setLoadError((e as Error).message);
    } finally {
      if (n === sent.current) setLoading(false);
    }
    const m = await mcp;
    if (m && n === sent.current) setServers(m.servers);
  };
  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  useEffect(() => {
    if (!open) return;
    setTab("plugins");
    setLoading(true);
    setInstalled([]);
    setAvailable([]);
    setMarketplaces([]);
    setSearch("");
    setPicking(undefined);
    setNotice(undefined);
    setError(undefined);
    setFailure(undefined);
    setFailedReload(undefined);
    setConfirmRemove(undefined);
    void load();
  }, [open, cwd, sessionId]);
  useEffect(() => void (open && changed && load()), [changed]);

  const clear = () => (setError(undefined), setNotice(undefined));
  const afterReload = (reload?: ReloadResult) => reload?.failed.length && setFailedReload(reload.failed);
  /** A write that answers PluginWriteResult: the error line on failure, the reload-failed dialog, then a fresh list. */
  const write = async (msg: Request) => {
    clear();
    try {
      afterReload((await request<PluginWriteResult>(msg)).reload);
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };
  const install = (p: AvailablePlugin, scope: string) => (setPicking(undefined), write({ type: "plugins.install", cwd, pluginId: p.pluginId, scope: scope as never }));
  const setEnabled = (id: string, enabled: boolean) => write({ type: "plugins.setEnabled", cwd, pluginId: id, enabled });
  const uninstall = (p: InstalledPlugin) => write({ type: "plugins.uninstall", cwd, pluginId: p.id, scope: p.scope });

  async function update(p: InstalledPlugin) {
    if (updating) return;
    clear();
    setFailure(undefined);
    setUpdating(p.id);
    try {
      const r = await request<PluginUpdateResult>({ type: "plugins.update", cwd, pluginId: p.id, scope: p.scope });
      if (r.outcome === "failed") {
        // A "turned off" answer for a plugin that is on is the generic failure (the extension's rule).
        setFailure({ plugin: p, kind: r.kind === "disabled" && p.enabled ? "other" : r.kind, message: r.message });
        return;
      }
      if (r.reload) afterReload(r.reload);
      else if (r.message) setNotice(updateNotice(p.id, r.message));
      await refresh();
    } catch (e) {
      setFailure({ plugin: p, kind: "other", message: (e as Error).message });
    } finally {
      setUpdating(undefined);
    }
  }
  async function onFailure(action: FailureAction, f: Failure) {
    if (action === "copy") return void navigator.clipboard?.writeText(f.message.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim());
    setFailure(undefined);
    try {
      if (action === "refreshList") return void (await refresh());
      if (action === "refreshMarketplace") await request({ type: "marketplace.update", cwd, name: marketplaceOf(f.plugin.id) });
      if (action === "enableAndUpdate") afterReload((await request<PluginWriteResult>({ type: "plugins.setEnabled", cwd, pluginId: f.plugin.id, enabled: true })).reload);
    } catch (e) {
      return setFailure({ ...f, kind: "other", message: (e as Error).message });
    }
    await update(f.plugin);
  }
  const restart = async (ids: string[]) => {
    clear();
    setFailedReload(undefined);
    try {
      for (const id of ids) await request({ type: "plugins.restart", cwd, sessionId: id });
      onRestarted(ids);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const retryReload = async () => {
    setFailedReload(undefined);
    try {
      afterReload(await request<ReloadResult>({ type: "plugins.reload", cwd }));
    } catch {
      setFailedReload(failedReload);
    }
  };

  async function addMarketplace() {
    const s = source.trim();
    if (!s || adding) return;
    clear();
    setAdding(true);
    try {
      await request({ type: "marketplace.add", cwd, source: s });
      setSource("");
      await refresh();
    } catch (e) {
      setError(`Failed to add marketplace: ${(e as Error).message}`);
    } finally {
      setAdding(false);
    }
  }
  async function removeMarketplace(name: string) {
    if (removing) return;
    setConfirmRemove(undefined);
    setRemoving(name);
    await write({ type: "marketplace.remove", cwd, name });
    setRemoving(undefined);
  }
  const refreshMarketplace = async (name: string) => {
    clear();
    try {
      await request({ type: "marketplace.update", cwd, name });
    } catch (e) {
      setError((e as Error).message);
    }
    await refresh();
  };

  const shown = filterAvailable(available, search);
  const lines = (
    <>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}
    </>
  );

  const pluginsTab = () => {
    if (loading) return <Status>Loading plugins…</Status>;
    if (adding) return <Status>Adding marketplace…</Status>;
    if (loadError) return <Banner kind="error">Failed to load plugins: {loadError}</Banner>;
    if (!installed.length && !shown.length && !search) return <Status>No plugins available. Add a marketplace to discover plugins.</Status>;
    return (
      <>
        {lines}
        <label className="relative flex items-center">
          <SearchIcon className="pointer-events-none absolute left-3 size-4 text-faint" aria-hidden />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plugins…"
            aria-label="Search plugins…"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full rounded-md bg-secondary/60 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary max-md:h-11 max-md:text-base"
            data-testid="plugins-search"
          />
        </label>
        {installed.length > 0 && (
          <Section title="Installed">
            {installed.map((p) => (
              <li key={`${p.id}:${p.scope}`} className="flex min-h-11 items-start gap-3 rounded-md px-3 py-2 hover:bg-secondary/50" data-testid="plugin-installed">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2 font-medium text-[13px]">
                    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", p.enabled ? "bg-success" : "bg-faint/50")} data-testid="plugin-dot" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{p.id}</span>
                  </div>
                  {p.description && <p className="text-muted-foreground text-xs leading-4">{p.description}</p>}
                  {!!p.mcpServers?.length && (
                    <div className="flex flex-wrap gap-1">
                      {p.mcpServers.map((s) => {
                        const c = chipOf(p.id, s, servers);
                        return (
                          <span key={s} title={c.title} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground text-xs ring-1 ring-border" data-testid="plugin-mcp">
                            <span aria-hidden className={cn("size-1.5 rounded-full", CHIP[c.status] ?? "bg-faint/50")} />
                            {s}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch on={p.enabled} label={`Enable ${p.id}`} held={!!updating} onToggle={(on) => void setEnabled(p.id, on)} />
                  {p.updatable && (
                    <IconButton label={updating === p.id ? "Updating…" : "Update plugin"} title={updating === p.id ? "Updating…" : "Update plugin to the latest version"} disabled={!!updating} onClick={() => void update(p)}>
                      <RefreshCwIcon className={cn(updating === p.id && "motion-safe:animate-spin")} />
                    </IconButton>
                  )}
                  <IconButton label={`Uninstall ${p.id}`} title="Uninstall and remove plugin" disabled={!!updating} onClick={() => void uninstall(p)}>
                    <Trash2Icon />
                  </IconButton>
                </div>
              </li>
            ))}
          </Section>
        )}
        {refreshing && !available.length && <Status>Loading available plugins…</Status>}
        {shown.length > 0 && (
          <Section title="Available">
            {shown.map((p) => (
              <li key={p.pluginId} className="flex min-h-11 flex-wrap items-start gap-3 rounded-md px-3 py-2 hover:bg-secondary/50" data-testid="plugin-available">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 font-medium text-[13px] [overflow-wrap:anywhere]">{p.name}</span>
                    {p.installCount > 0 && <span className="text-faint text-xs">{formatInstalls(p.installCount)} installs</span>}
                  </div>
                  {p.description && <p className="text-muted-foreground text-xs leading-4">{p.description}</p>}
                  <p className="flex items-center gap-1 text-faint text-xs">
                    from {p.marketplaceName}
                    {p.official && <Official />}
                  </p>
                  {p.sourceUrl && (
                    <p className="min-w-0 break-all text-faint text-xs">
                      Source:{" "}
                      <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:text-foreground hover:underline">
                        {p.sourceUrl}
                      </a>
                    </p>
                  )}
                  {picking === p.pluginId && (
                    <div className="mt-1 flex flex-col gap-1.5" data-testid="plugin-scopes">
                      <p className="rounded-md bg-warning/10 px-3 py-2 text-xs leading-4">{TRUST_WARNING}</p>
                      {INSTALL_SCOPES.map((s) => (
                        <button
                          key={s.scope}
                          type="button"
                          onClick={() => void install(p, s.scope)}
                          className="flex min-h-11 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left outline-none ring-1 ring-border hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="font-medium text-[13px]">{s.label}</span>
                          <span className="text-muted-foreground text-xs">{s.description}</span>
                        </button>
                      ))}
                      <button type="button" onClick={() => setPicking(undefined)} className="self-start text-muted-foreground text-sm underline-offset-4 hover:text-foreground hover:underline max-md:min-h-11">
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
                {picking !== p.pluginId && (
                  <Button size="sm" className="shrink-0 max-md:h-11" onClick={() => setPicking(p.pluginId)}>
                    Install
                  </Button>
                )}
              </li>
            ))}
          </Section>
        )}
        {search && !shown.length && <Status>No plugins match.</Status>}
      </>
    );
  };

  const marketplacesTab = () => {
    if (loading) return <Status>Loading marketplaces…</Status>;
    if (loadError) return <Banner kind="error">Failed to load marketplaces: {loadError}</Banner>;
    return (
      <>
        {error && <Banner kind="error">{error}</Banner>}
        <div className="flex gap-2">
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addMarketplace()}
            placeholder="GitHub repo, URL, or path…"
            aria-label="GitHub repo, URL, or path…"
            autoComplete="off"
            spellCheck={false}
            className="h-9 min-w-0 flex-1 rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary max-md:h-11 max-md:text-base"
            data-testid="marketplace-source"
          />
          <Button className="h-9 max-md:h-11" disabled={!source.trim() || adding} onClick={() => void addMarketplace()}>
            {adding ? "Adding…" : "Add"}
          </Button>
        </div>
        {!marketplaces.length ? (
          <Status>No marketplaces configured. Add one above to discover plugins.</Status>
        ) : (
          <ul className="flex flex-col gap-px">
            {marketplaces.map((m) => {
              const link = marketplaceLink(m);
              return (
                <li key={m.name} className="flex min-h-11 flex-wrap items-center gap-3 rounded-md px-3 py-2 hover:bg-secondary/50" data-testid="marketplace-row">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-1 font-medium text-[13px]">
                      {m.name}
                      {m.official && <Official />}
                    </span>
                    <span className="min-w-0 break-all text-muted-foreground text-xs">
                      {link ? (
                        <a href={link} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:text-foreground hover:underline">
                          {marketplaceText(m)}
                        </a>
                      ) : (
                        marketplaceText(m)
                      )}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton label="Refresh marketplace" onClick={() => void refreshMarketplace(m.name)}>
                      <RefreshCwIcon />
                    </IconButton>
                    <IconButton label={removing === m.name ? "Removing…" : "Remove marketplace"} disabled={!!removing} onClick={() => setConfirmRemove(m.name)}>
                      <Trash2Icon />
                    </IconButton>
                  </div>
                  {/* Owner decision (GH-42 question 3): removing a marketplace uninstalls its plugins, so it asks first. */}
                  {confirmRemove === m.name && (
                    <div className="flex w-full flex-wrap items-center gap-2" data-testid="marketplace-remove-confirm">
                      <span className="text-sm">Remove {m.name}? Its plugins are uninstalled.</span>
                      <Button variant="destructive" className="max-md:h-11" autoFocus onClick={() => void removeMarketplace(m.name)}>
                        Remove
                      </Button>
                      <Button variant="secondary" className="max-md:h-11" onClick={() => setConfirmRemove(undefined)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  };

  const failureView = failure && failureDialog(failure.kind, failure.plugin.id);
  return (
    <ConfigDialog title="Manage Plugins" open={open} onClose={onClose} busy={!!removing} testId="plugins-dialog">
      {reloadFailed && sessionId && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm" data-testid="plugins-restart-banner">
          <span className="flex-1">Restart Claude to apply plugin changes</span>
          <Button size="sm" className="max-md:h-11" onClick={() => void restart([sessionId])}>
            Restart
          </Button>
        </div>
      )}
      <div role="tablist" aria-label="Manage Plugins" className="flex gap-1 border-b pb-2">
        {(
          [
            ["plugins", "Plugins", installed.length],
            ["marketplaces", "Marketplaces", marketplaces.length],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:h-11",
              tab === id && "bg-secondary text-foreground",
            )}
            data-testid={`plugins-tab-${id}`}
          >
            {label}
            {count > 0 && <span className="rounded bg-background px-1 font-medium text-[11px] text-muted-foreground ring-1 ring-border">{count}</span>}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="flex flex-col gap-3">
        {tab === "plugins" ? pluginsTab() : marketplacesTab()}
      </div>
      {failure && failureView && (
        <SmallDialog title={failureView.title} message={failureView.message} close={failureView.close} closePrimary={!failureView.actions.length} onClose={() => setFailure(undefined)} testId="plugins-update-failure">
          {failureView.actions.map((a, i) => (
            <Button key={a.label} variant={i === 0 ? "default" : "secondary"} className="max-md:h-11" onClick={() => void onFailure(a.action, failure)}>
              {a.label}
            </Button>
          ))}
        </SmallDialog>
      )}
      {failedReload && (
        <SmallDialog title="Reload plugins" message="This session couldn't reload its plugins." close="Cancel" onClose={() => setFailedReload(undefined)} testId="plugins-reload-failed">
          <Button className="max-md:h-11" onClick={() => void retryReload()}>
            Try again
          </Button>
          <Button variant="secondary" className="max-md:h-11" onClick={() => void restart(failedReload)}>
            Restart
          </Button>
        </SmallDialog>
      )}
    </ConfigDialog>
  );
}

const CHIP: Record<string, string> = { connected: "bg-success", failed: "bg-destructive", "needs-auth": "bg-warning", pending: "bg-info" };

const Status = ({ children }: { children: ReactNode }) => <p className="text-muted-foreground text-sm">{children}</p>;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-px">
      <h3 className="my-1.5 px-3 text-[13px] text-muted-foreground leading-4">{title}</h3>
      <ul className="flex flex-col gap-px">{children}</ul>
    </section>
  );
}

const Official = () => (
  <span title="Official Claude Code marketplace" aria-label="Official Claude Code marketplace" role="img" className="inline-flex text-info">
    <BadgeCheckIcon className="size-3.5" />
  </span>
);

function IconButton({ label, title, disabled, onClick, children }: { label: string; title?: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={title ?? label} disabled={disabled} onClick={onClick} className="text-muted-foreground max-md:size-11">
      {children}
    </Button>
  );
}

/** The extension's plugin switch: `role="switch"`, Enter/Space toggle; OpenCode's 28×16 switch look, 44 px hit area on touch. */
function Switch({ on, label, held, onToggle }: { on: boolean; label: string; held: boolean; onToggle: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={held}
      title={on ? "Disable plugin (stays installed but will not load)" : "Enable plugin"}
      onClick={() => !held && onToggle(!on)}
      className="group grid size-7 place-items-center rounded-md outline-none max-md:size-11"
      data-testid="plugin-switch"
    >
      <span
        className={cn(
          "flex h-4 w-7 items-center rounded-[3px] border transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring",
          on ? "border-foreground bg-foreground" : "border-border bg-secondary group-hover:bg-accent",
          held && "opacity-50",
        )}
      >
        <span className={cn("size-3.5 rounded-[2px] bg-background shadow-sm transition-transform", on ? "translate-x-[12px]" : "-translate-x-px ring-1 ring-border")} />
      </span>
    </button>
  );
}

/** The extension's small confirm dialog over the plugins dialog (nested modal): title, message, actions, close button. */
function SmallDialog({ title, message, close, closePrimary, onClose, children, testId }: { title: string; message: string; close: string; closePrimary?: boolean; onClose: () => void; children: ReactNode; testId: string }) {
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          onKeyDown={trapTab}
          aria-modal="true"
          role="alertdialog"
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex w-[min(100vw-24px,400px)] flex-col gap-2 rounded-xl bg-card p-4 text-foreground shadow-floating outline-none"
          data-testid={testId}
        >
          <Dialog.Title className="font-medium text-[15px]">{title}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">{message}</Dialog.Description>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {children}
            <Dialog.Close render={<Button variant={closePrimary ? "default" : "secondary"} className="max-md:h-11" />}>{close}</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
