// "MCP servers" dialog (/mcp), a copy of the Claude Code VS Code extension's: list by config scope, detail with the actions the
// status allows, OAuth with paste-back, tools, add form, remove. Logic and texts in mcp.ts.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { SearchIcon } from "lucide-react";
import type { ConfigScope, McpAddConfig, McpAuthResult, McpListResult, McpServerInfo } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import {
  ACTION_ERROR,
  ACTION_LABEL,
  actionsFor,
  buildAdd,
  canRemove,
  errorLine,
  groupServers,
  PROJECT_SCOPE_WARNING,
  resultText,
  safeAuthUrl,
  SCOPES,
  scopeLabel,
  statusIcon,
  statusLabel,
  TRANSPORTS,
  type AddForm,
  type McpAction,
} from "./mcp.ts";

/** Status polling: every 2 s while an OAuth flow waits (the extension's), every 5 s while a server is connecting. */
export const AUTH_POLL_MS = 2000;
export const PENDING_POLL_MS = 5000;
const DOCS = "https://code.claude.com/docs/en/mcp";

type Busy = { server: string; action: McpAction | "remove" };

/**
 * `cwd`: the project (session cwd or the new-session tab's project); `sessionId`: the shown session, whose live query answers
 * when it has one. `server`: opens that server's detail. `changed`: bumped on `config.changed` for `cwd`.
 */
export function McpDialog({
  open,
  cwd,
  sessionId,
  server: initialServer,
  changed = 0,
  request,
  onClose,
}: {
  open: boolean;
  cwd: string;
  sessionId?: string;
  server?: string;
  changed?: number;
  request: <T>(msg: Request) => Promise<T>;
  onClose: () => void;
}) {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<string | undefined>(initialServer);
  const [busy, setBusy] = useState<Busy>();
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [showTools, setShowTools] = useState(false);
  // OAuth flow waiting for the browser: the server and its sign-in page.
  const [waiting, setWaiting] = useState<string>();
  const [authUrl, setAuthUrl] = useState<string>();
  const [callbackUrl, setCallbackUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [filter, setFilter] = useState("");

  const base = { cwd, ...(sessionId && { sessionId }) };
  const ask = useRef(request);
  ask.current = request;
  const where = useRef(base);
  where.current = base;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  // A slower older answer must not replace a newer one.
  const sent = useRef(0);
  const shown = useRef(0);
  const load = useCallback(async () => {
    const n = ++sent.current;
    try {
      const r = await ask.current<McpListResult>({ type: "mcp.list", ...where.current });
      if (n < shown.current) return;
      shown.current = n;
      setLoadError(undefined);
      setServers(r.servers);
      const w = r.servers.find((s) => s.name === waitingRef.current);
      if (w?.status === "connected") setWaiting(undefined);
    } catch (e) {
      if (n < shown.current) return;
      shown.current = n;
      setLoadError((e as Error).message || "Failed to load MCP servers");
    } finally {
      if (n === shown.current) setLoading(false), setRetrying(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setServers([]);
    setLoading(true);
    setSelected(initialServer);
    setBusy(undefined);
    setError(undefined);
    setSuccess(undefined);
    setShowTools(false);
    setWaiting(undefined);
    setAdding(false);
    setFilter("");
    void load();
  }, [open, cwd, sessionId]);
  useEffect(() => void (open && setSelected(initialServer)), [initialServer]);
  useEffect(() => void (open && changed && load()), [changed]);
  const pending = servers.some((s) => s.status === "pending");
  useEffect(() => {
    if (!open || (!waiting && !pending)) return;
    const t = setInterval(load, waiting ? AUTH_POLL_MS : PENDING_POLL_MS);
    return () => clearInterval(t);
  }, [open, waiting, pending]);
  // The shown server left the list (removed elsewhere, disabled by a plugin change): back to the list.
  useEffect(() => {
    if (!loading && selected && servers.length && !servers.some((s) => s.name === selected)) setSelected(undefined), setWaiting(undefined);
  }, [loading, servers, selected]);

  const clear = () => (setError(undefined), setSuccess(undefined));
  /** Opens a server's detail, or the list (which ends a waiting OAuth block, as the extension's Back does). */
  const show = (name?: string) => {
    clear();
    setSelected(name);
    setShowTools(false);
    if (!name) setWaiting(undefined);
  };
  /** Runs an action with its busy label, then the success text or the error, then refreshes the list. */
  const act = async (server: string, action: Busy["action"], run: () => Promise<unknown>, ok: string, after?: () => void) => {
    clear();
    setBusy({ server, action });
    try {
      await run();
      setSuccess(ok);
      after?.();
    } catch (e) {
      // The failure text of the action, with the CLI's reason when it gives one.
      const reason = (e as Error).message;
      setError(reason ? `${ACTION_ERROR[action]}: ${reason}` : ACTION_ERROR[action]);
    } finally {
      setBusy(undefined);
      await load();
    }
  };
  /** Back to the whole list after Disable or Remove (a filter would show only part of it). */
  const toList = () => (setSelected(undefined), setWaiting(undefined), setFilter(""));
  const named = (type: "mcp.reconnect" | "mcp.clearAuth", name: string) => request({ type, ...base, name });
  const toggle = (name: string, enabled: boolean) => request({ type: "mcp.toggle", ...base, name, enabled });
  const run: Record<McpAction, (name: string) => unknown> = {
    reconnect: (n) => act(n, "reconnect", () => named("mcp.reconnect", n), resultText.reconnect(n)),
    clearAuth: (n) => act(n, "clearAuth", () => named("mcp.clearAuth", n), resultText.clearAuth(n)),
    disable: (n) => act(n, "disable", () => toggle(n, false), resultText.disable(n), toList),
    enable: (n) => act(n, "enable", () => toggle(n, true), resultText.enable(n)),
    authenticate: (n) => authenticate(n),
  };
  const checkConnection = (n: string) => (setWaiting(undefined), run.reconnect(n));

  async function authenticate(name: string) {
    clear();
    setBusy({ server: name, action: "authenticate" });
    // Opened now, in the click: a tab opened after the reply would be blocked as a popup.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const r = await request<McpAuthResult>({ type: "mcp.authenticate", ...base, name });
      if (r.authUrl && !safeAuthUrl(r.authUrl)) throw new Error(`Sign-in page not opened: not https: ${r.authUrl}`);
      if (r.authUrl && tab) tab.location.href = r.authUrl;
      else tab?.close();
      if (r.requiresUserAction) {
        setWaiting(name);
        setAuthUrl(r.authUrl);
        setCallbackUrl("");
      } else {
        setSuccess(resultText.authenticate());
        await load();
      }
    } catch (e) {
      tab?.close();
      setError((e as Error).message || ACTION_ERROR.authenticate);
    } finally {
      setBusy(undefined);
    }
  }
  async function submitCallback(name: string) {
    const url = callbackUrl.trim();
    if (!url) return;
    try {
      await request({ type: "mcp.oauthCallback", ...base, name, callbackUrl: url });
      setCallbackUrl("");
      void checkConnection(name);
    } catch (e) {
      setError((e as Error).message || ACTION_ERROR.callback);
    }
  }
  const remove = (name: string, scope: ConfigScope) =>
    act(name, "remove", () => request({ type: "mcp.remove", cwd, name, scope }), resultText.remove(name, scope), toList);
  const add = async (name: string, scope: ConfigScope, config: McpAddConfig) => {
    await request({ type: "mcp.add", cwd, name, scope, config });
    setSuccess(resultText.add(name, scope));
    setAdding(false);
    setFilter("");
    void load();
  };

  const current = servers.find((s) => s.name === selected);
  const groups = groupServers(servers, filter);
  const empty = !servers.length && !loadError;
  const banners = (
    <>
      {success && <Banner kind="success">{success}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
    </>
  );
  const addButton = (
    <Button variant="secondary" className="self-start max-md:h-11" onClick={() => (clear(), setAdding(true))} data-testid="mcp-add">
      Add server
    </Button>
  );

  return (
    <ConfigDialog
      title="MCP servers"
      open={open}
      onClose={onClose}
      busy={formBusy || busy?.action === "remove"}
      testId="mcp-dialog"
      footer={
        <a href={DOCS} target="_blank" rel="noopener noreferrer" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
          Learn more about MCP
        </a>
      }
    >
      {loading && <p className="text-muted-foreground text-sm">Loading MCP servers…</p>}
      {retrying && !adding && <p className="text-muted-foreground text-sm">Retrying…</p>}
      {!loading && !retrying && !adding && empty && (
        <div className="flex flex-col items-start gap-3 py-2">
          {banners}
          <p className="text-muted-foreground text-sm">No MCP servers configured.</p>
          {addButton}
        </div>
      )}
      {loadError && !adding && (
        <Banner kind="error">
          Failed to load servers: {loadError}
          <br />
          <button type="button" className="underline underline-offset-4" onClick={() => (setRetrying(true), void load())}>
            Retry
          </button>
        </Banner>
      )}
      {loadError && !adding && !current && !servers.length && addButton}
      {!loading && !adding && servers.length > 0 && !current && (
        <>
          {banners}
          <label className="relative flex items-center">
            <SearchIcon className="pointer-events-none absolute left-3 size-4 text-faint" aria-hidden />
            <input
              autoFocus
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter servers…"
              aria-label="Filter servers…"
              autoComplete="off"
              spellCheck={false}
              className="h-9 w-full rounded-md bg-secondary/60 pr-3 pl-9 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary max-md:h-11 max-md:text-base"
              data-testid="mcp-filter"
            />
          </label>
          {!groups.length && <p className="py-6 text-center text-muted-foreground text-sm">No matching servers.</p>}
          <div className="flex flex-col gap-4" data-testid="mcp-list">
            {groups.map(([scope, list]) => (
              <div key={scope} className="flex flex-col gap-px">
                <p className="my-1.5 px-3 text-[13px] text-muted-foreground leading-4" data-testid="mcp-scope">
                  {scopeLabel(scope)} ({list.length})
                </p>
                {list.map((s) => (
                  <div
                    key={s.name}
                    role="button"
                    tabIndex={0}
                    onClick={() => show(s.name)}
                    onKeyDown={(e: KeyboardEvent) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      if (!e.repeat) show(s.name);
                    }}
                    className={cn(
                      "flex h-9 cursor-pointer items-center gap-2 rounded-md px-3 text-[13px] outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11",
                      s.status === "disabled" && "opacity-60",
                    )}
                    data-testid="mcp-row"
                  >
                    <span className="min-w-0 truncate font-medium">{s.name}</span>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
              </div>
            ))}
          </div>
          {addButton}
        </>
      )}
      {!loading && adding && <AddServer onSubmit={add} onBack={() => setAdding(false)} onBusy={setFormBusy} />}
      {!loading && !adding && current && (
        <div className="flex flex-col items-start gap-3" data-testid="mcp-detail">
          <Button
            variant="ghost"
            size="sm"
            autoFocus
            className="-ml-2 text-muted-foreground max-md:h-11"
            onClick={() => show(undefined)}
            onKeyDown={(e) => e.repeat && (e.key === "Enter" || e.key === " ") && e.preventDefault()}
          >
            ← Back to list
          </Button>
          {banners}
          {!error && current.error && <Banner kind="error">{errorLine(current.error)}</Banner>}
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <h3 className="min-w-0 truncate font-medium text-[15px]">{current.name}</h3>
            <StatusBadge status={current.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {actionsFor(current, waiting === current.name).map((a) => (
              <Button
                key={a}
                variant={a === "clearAuth" ? "destructive" : a === "authenticate" || a === "enable" ? "default" : "secondary"}
                className="max-md:h-11"
                // Clear authentication and Authenticate wait for any action; the others only for their server's.
                disabled={a === "clearAuth" || a === "authenticate" ? !!busy : busy?.server === current.name}
                onClick={() => run[a](current.name)}
                data-testid={`mcp-${a}`}
              >
                {busy?.server === current.name && busy.action === a ? ACTION_LABEL[a][1] : ACTION_LABEL[a][0]}
              </Button>
            ))}
            {canRemove(current) && (
              <Remove key={current.name} name={current.name} scope={current.scope} disabled={!!busy} removing={busy?.server === current.name && busy.action === "remove"} onRemove={() => remove(current.name, current.scope)} />
            )}
          </div>
          {waiting === current.name && current.status !== "connected" && (
            <div className="flex w-full flex-col gap-2 rounded-md bg-secondary/60 p-3 text-sm" data-testid="mcp-auth-wait">
              <div className="flex flex-wrap items-center gap-2">
                <span>Completing authentication in browser…</span>
                <Button variant="secondary" size="sm" className="max-md:h-11" onClick={() => checkConnection(current.name)}>
                  Check connection
                </Button>
              </div>
              {/* The CLI's redirect listener is on the daemon machine: a phone's redirect fails, so its URL is pasted here. */}
              <strong className="font-medium">If the redirect page shows a connection error, paste the URL from your browser's address bar:</strong>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitCallback(current.name)}
                  placeholder="http://localhost:.../callback?code=...&state=..."
                  aria-label="Callback URL"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-md bg-background px-3 text-sm outline-none ring-1 ring-border placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-base"
                  data-testid="mcp-callback"
                />
                <Button className="max-md:h-11" onClick={() => void submitCallback(current.name)}>
                  Submit
                </Button>
              </div>
              {authUrl && (
                <a href={authUrl} target="_blank" rel="noopener noreferrer" className="self-start text-muted-foreground underline underline-offset-4 hover:text-foreground max-md:inline-flex max-md:min-h-11 max-md:items-center">
                  Re-open authentication page
                </a>
              )}
            </div>
          )}
          {current.status === "connected" && !!current.tools?.length && (
            <button type="button" className="text-muted-foreground text-sm hover:text-foreground max-md:min-h-11" onClick={() => setShowTools((v) => !v)} aria-expanded={showTools} data-testid="mcp-tools-toggle">
              {showTools ? "Hide tools ▴" : `View tools (${current.tools.length}) ▾`}
            </button>
          )}
          {showTools && current.tools && (
            <ul className="flex w-full flex-col gap-px" data-testid="mcp-tools">
              {current.tools.map((t) => (
                <li key={t.name} className="flex min-h-8 items-center gap-2 rounded-md px-3 text-[13px]">
                  <span className="min-w-0 truncate font-mono">{t.name}</span>
                  {t.readOnly && <span className="rounded px-1.5 py-0.5 text-muted-foreground text-xs ring-1 ring-border">read-only</span>}
                  {t.destructive && <span className="rounded px-1.5 py-0.5 text-destructive text-xs ring-1 ring-destructive/40">destructive</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </ConfigDialog>
  );
}

const ICON_COLOR: Record<string, string> = { connected: "text-success", failed: "text-destructive", "needs-auth": "text-warning" };

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground" data-testid="mcp-status">
      <span aria-hidden className={ICON_COLOR[status] ?? "text-faint"}>
        {statusIcon(status)}
      </span>
      {statusLabel(status)}
    </span>
  );
}

/** "Remove" with the extension's inline confirmation. */
function Remove({ name, scope, disabled, removing, onRemove }: { name: string; scope: ConfigScope; disabled: boolean; removing: boolean; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm)
    return (
      <Button variant="destructive" className="max-md:h-11" disabled={disabled} onClick={() => setConfirm(true)} data-testid="mcp-remove">
        Remove
      </Button>
    );
  return (
    <div className="flex w-full flex-wrap items-center gap-2" data-testid="mcp-remove-confirm">
      <span className="text-sm">
        Remove {name} from {scope} config?
      </span>
      <Button variant="destructive" className="max-md:h-11" disabled={disabled} onClick={onRemove} autoFocus>
        {removing ? "Removing…" : "Confirm remove"}
      </Button>
      <Button variant="secondary" className="max-md:h-11" disabled={disabled} onClick={() => setConfirm(false)}>
        Cancel
      </Button>
    </div>
  );
}

const field = "flex flex-col gap-1.5";
const label = "font-medium text-[13px]";
const inputClass =
  "w-full rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:text-base";

/** "Add MCP server" form. `onSubmit` rejects with the daemon's error, shown above the form. */
function AddServer({ onSubmit, onBack, onBusy }: { onSubmit: (name: string, scope: ConfigScope, config: McpAddConfig) => Promise<void>; onBack: () => void; onBusy: (b: boolean) => void }) {
  const [form, setForm] = useState<AddForm>({ name: "", transport: "stdio", command: "", args: "", env: "", url: "", headers: "" });
  const [scope, setScope] = useState<ConfigScope>("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (k: keyof AddForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    const r = buildAdd(form);
    if ("error" in r) return setError(r.error);
    setError(undefined);
    setBusy(true);
    onBusy(true);
    try {
      await onSubmit(r.name, scope, r.config);
    } catch (e) {
      setError((e as Error).message || "Failed to add server");
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const options = <T extends string>(name: string, list: readonly { value: T; label: string; description: string }[], value: T, onChange: (v: T) => void) => (
    <div className={field}>
      <span className={label}>{name}</span>
      <div className="grid gap-1.5 sm:grid-cols-3" role="group" aria-label={name}>
        {list.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex min-h-11 flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left outline-none ring-1 ring-border hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring",
              value === o.value && "bg-secondary ring-2 ring-primary",
            )}
          >
            <span className="font-medium text-[13px]">{o.label}</span>
            <span className="text-muted-foreground text-xs">{o.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col items-stretch gap-3" data-testid="mcp-add-form">
      <Button variant="ghost" size="sm" className="-ml-2 self-start text-muted-foreground max-md:h-11" onClick={onBack} disabled={busy}>
        ← Back to list
      </Button>
      <h3 className="font-medium text-[15px]">Add MCP server</h3>
      {error && <Banner kind="error">{error}</Banner>}
      <div className={field}>
        <label className={label} htmlFor="mcp-add-name">
          Name
        </label>
        <input id="mcp-add-name" autoFocus className={cn(inputClass, "h-9 max-md:h-11")} placeholder="example-tools" value={form.name} onChange={set("name")} autoComplete="off" spellCheck={false} />
      </div>
      {options("Transport", TRANSPORTS, form.transport, (t) => setForm((f) => ({ ...f, transport: t })))}
      {form.transport === "stdio" ? (
        <>
          <div className={field}>
            <label className={label} htmlFor="mcp-add-command">
              Command
            </label>
            <input id="mcp-add-command" className={cn(inputClass, "h-9 max-md:h-11")} placeholder="npx" value={form.command} onChange={set("command")} autoComplete="off" spellCheck={false} />
          </div>
          <div className={field}>
            <label className={label} htmlFor="mcp-add-args">
              Arguments (one per line)
            </label>
            <textarea id="mcp-add-args" rows={3} className={cn(inputClass, "py-2 font-mono")} value={form.args} onChange={set("args")} spellCheck={false} />
          </div>
          <div className={field}>
            <label className={label} htmlFor="mcp-add-env">
              Environment variables (KEY=value, one per line)
            </label>
            <textarea id="mcp-add-env" rows={3} className={cn(inputClass, "py-2 font-mono")} value={form.env} onChange={set("env")} spellCheck={false} />
          </div>
        </>
      ) : (
        <>
          <div className={field}>
            <label className={label} htmlFor="mcp-add-url">
              URL
            </label>
            <input id="mcp-add-url" className={cn(inputClass, "h-9 max-md:h-11")} placeholder="https://example.com/mcp" value={form.url} onChange={set("url")} autoComplete="off" spellCheck={false} />
          </div>
          <div className={field}>
            <label className={label} htmlFor="mcp-add-headers">
              Headers (Header-Name: value, one per line)
            </label>
            <textarea id="mcp-add-headers" rows={3} className={cn(inputClass, "py-2 font-mono")} value={form.headers} onChange={set("headers")} spellCheck={false} />
          </div>
        </>
      )}
      {options("Scope", SCOPES, scope, setScope)}
      {scope === "project" && <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">{PROJECT_SCOPE_WARNING}</p>}
      <Button className="self-start max-md:h-11" onClick={() => void submit()} disabled={busy} data-testid="mcp-add-submit">
        {busy ? "Adding…" : "Add server"}
      </Button>
    </div>
  );
}
