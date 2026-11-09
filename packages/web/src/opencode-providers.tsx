// Settings › OpenCode › Providers (docs/spec.md "OpenCode engine" › Provider login): connect and log out of providers through the daemon.
// Keys, inputs and codes live in component state only: sent once, cleared on success, gone on unmount.
import { useEffect, useRef, useState } from "react";
import type { OpenCodeAuthMethod, OpenCodeAuthPrompt, OpenCodeLoginStart, OpenCodeProvider, OpenCodeProvidersResult, OpenCodeStatus } from "@claude-ui/protocol";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Request } from "./client.ts";
import { useT } from "./i18n.ts";
import { safeAuthUrl } from "./mcp.ts";
import { ConfirmDialog } from "./session-actions.tsx";

type Phase = { kind: "idle" } | { kind: "busy" } | { kind: "oauth"; start: OpenCodeLoginStart; unsafe: boolean };
type Fail = { field?: string; text: string };

const input = "h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
const shown = (p: OpenCodeAuthPrompt, v: Record<string, string>) => !p.when || ((v[p.when.key] ?? "") === p.when.value) === (p.when.op === "eq");
const initial = (m: OpenCodeAuthMethod) => Object.fromEntries((m.prompts ?? []).flatMap((p) => (p.type === "select" && p.options[0] ? [[p.key, p.options[0].value]] : [])));
/** An error text `field: message` names the field it belongs to. */
const split = (e: Error, fields: string[]): Fail => {
  const m = /^([\w-]+): (.*)$/s.exec(e.message);
  return m && fields.includes(m[1]!) ? { field: m[1], text: m[2]! } : { text: e.message };
};

export function OpenCodeProviders({ status, request, onProviders, onLoaded }: { status: OpenCodeStatus | undefined; request: <T>(m: Request) => Promise<T>; onProviders: () => void; /** The first list loaded: the server is running now (status line). */ onLoaded?: () => void }) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [providers, setProviders] = useState<OpenCodeProvider[]>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const [query, setQuery] = useState("");
  const [formId, setFormId] = useState<string>();
  const [logout, setLogout] = useState<OpenCodeProvider>();
  const [method, setMethod] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [key, setKey] = useState("");
  const [code, setCode] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fail, setFail] = useState<Fail>();
  const [focus, setFocus] = useState<string>();
  const attempt = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  const apply = (r: OpenCodeProvidersResult) => (setProviders(r.providers), setLoadError(undefined), onProviders());
  const load = () => (setLoading(true), setLoadError(undefined), request<OpenCodeProvidersResult>({ type: "opencode.providers" }).then((r) => (setProviders(r.providers), onLoaded?.()), (e: Error) => setLoadError(e.message)).finally(() => setLoading(false)));
  useEffect(() => {
    if (status?.state === "running" && !providers) void load();
  }, [status?.state]);
  // The row that opened the form unmounts with focus on it: focus moves to the form heading.
  useEffect(() => {
    if (formId) heading.current?.focus();
  }, [formId]);
  // Focus after a login or logout lands in the list.
  useEffect(() => {
    if (focus === undefined) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-testid="settings-opencode-logout"][data-provider-id="${CSS.escape(focus)}"]`) ?? root.current?.querySelector<HTMLElement>("h4");
    el?.focus();
    setFocus(undefined);
  }, [focus, providers]);

  if (!status || !["running", "stopped"].includes(status.state)) return null;
  const connected = providers?.filter((p) => p.connected) ?? [];
  const provider = providers?.find((p) => p.id === formId);
  const m = provider?.methods[method];
  const vis = (m?.prompts ?? []).filter((p) => shown(p, values));
  const fields = ["key", "code", ...(m?.prompts ?? []).map((p) => p.key)];

  const open = (p: OpenCodeProvider) => {
    setFormId(p.id), setMethod(0), setValues(initial(p.methods[0]!)), setKey(""), setCode(""), setPhase({ kind: "idle" }), setFail(undefined), setNote(undefined);
  };
  const pick = (i: number) => (setMethod(i), setValues(initial(provider!.methods[i]!)), setKey(""), setFail(undefined));
  const close = () => (attempt.current++, setFormId(undefined), setKey(""), setCode(""), setPhase({ kind: "idle" }), setFail(undefined));
  const done = (r: OpenCodeProvidersResult, id: string, name: string) => (apply(r), close(), setQuery(""), setNote({ text: t("settings.opencode.providers.connectedTo", { name }) }), setFocus(id));

  /** The error of a field the user can fix, else of the form. */
  const check = (): Fail | undefined => {
    for (const p of vis) if (p.type === "text" && !(values[p.key] ?? "").trim()) return { field: p.key, text: t("settings.opencode.providers.enter", { what: p.message }) };
    if (m?.type === "api") return keyError();
  };
  const keyError = (): Fail | undefined => (!key.trim() ? { field: "key", text: t("settings.opencode.providers.keyEmpty") } : /\s/.test(key) ? { field: "key", text: t("settings.opencode.providers.keySpace") } : undefined);
  const inputs = () => (vis.length ? Object.fromEntries(vis.map((p) => [p.key, values[p.key] ?? ""])) : undefined);

  const finish = (id: string, name: string, mi: number, withCode?: string) => {
    const mine = ++attempt.current;
    request<OpenCodeProvidersResult>({ type: "opencode.loginFinish", provider: id, method: mi, ...(withCode && { code: withCode }) }).then(
      (r) => mine === attempt.current && done(r, id, name),
      (e: Error & { code?: string }) => {
        if (mine !== attempt.current || e.code === "cancelled") return;
        // A wrong code is an error of the code field and can be retried in place; a failed browser login starts over.
        if (withCode) return setFail({ field: "code", text: split(e, fields).text });
        setFail(split(e, fields));
        setPhase({ kind: "idle" });
      },
    );
  };

  const submit = () => {
    if (!provider || !m || phase.kind === "busy") return;
    const bad = check();
    if (bad) return setFail(bad);
    setFail(undefined), setNote(undefined);
    // Opened inside the click: a tab opened after the await is blocked as a popup.
    const tab = m.type === "oauth" ? window.open("", "_blank") : null;
    if (tab) tab.opener = null;
    setPhase({ kind: "busy" });
    request<OpenCodeProvidersResult | OpenCodeLoginStart>({ type: "opencode.login", provider: provider.id, method, ...(m.type === "api" && { key }), ...(inputs() && { inputs: inputs() }) }).then(
      (r) => {
        if (m.type === "api") return done(r as OpenCodeProvidersResult, provider.id, provider.name);
        const start = r as OpenCodeLoginStart;
        const safe = safeAuthUrl(start.url);
        if (tab) safe ? (tab.location.href = start.url) : tab.close();
        setPhase({ kind: "oauth", start, unsafe: !safe });
        if (!safe) return setFail({ text: t("settings.opencode.providers.unsafeUrl", { url: start.url }) });
        if (start.mode === "auto") finish(provider.id, provider.name, method);
      },
      (e: Error) => (tab?.close(), setPhase({ kind: "idle" }), setFail(split(e, fields))),
    );
  };
  const cancel = () => {
    if (!provider) return;
    attempt.current++;
    void request({ type: "opencode.loginCancel", provider: provider.id }).catch(() => {});
    setFail(undefined), setNote({ text: t("settings.opencode.providers.cancelled") });
    // The Connect button takes Cancel's place: swapped at once, the same click lands on it (seen in Chromium) and starts a new login.
    setTimeout(() => setPhase({ kind: "idle" }), 150);
  };
  const doLogout = () => {
    const p = logout!;
    setLogout(undefined);
    request<OpenCodeProvidersResult>({ type: "opencode.logout", provider: p.id }).then(
      (r) => (apply(r), setNote({ text: t("settings.opencode.providers.loggedOut", { name: p.name }) }), setFocus("")),
      (e: Error) => setNote({ text: e.message, error: true }),
    );
  };

  const q = query.trim().toLowerCase();
  const rows = (providers ?? []).filter((p) => !p.connected && (!q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)));
  const statusText = (p: OpenCodeProvider) => t(p.source === "env" ? "settings.opencode.providers.statusEnv" : p.source === "config" ? "settings.opencode.providers.statusConfig" : p.source === "api" ? "settings.opencode.providers.statusApi" : "settings.opencode.providers.statusConnected");
  const err = (field: string) => fail?.field === field && fail.text;
  const errProps = (field: string, id: string) => (err(field) ? { "aria-invalid": true, "aria-describedby": id } : {});

  return (
    <div ref={root} className="flex flex-col border-t py-2" data-testid="settings-opencode-providers">
      <h4 tabIndex={-1} className="pb-1 font-medium text-[13px] text-muted-foreground outline-none">
        {t("settings.opencode.providers.title")}
      </h4>
      {note && (
        <p role={note.error ? "alert" : "status"} className={`pb-1 text-sm ${note.error ? "text-destructive" : ""}`} data-testid="settings-opencode-providers-message">
          {note.text}
        </p>
      )}
      {loading && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm" data-testid="settings-opencode-providers-loading">
          <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          {t("settings.opencode.providers.loading")}
        </p>
      )}
      {!providers && !loading && status.state === "stopped" && !loadError && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t("settings.opencode.providers.notRunning")}</p>
          <Button variant="secondary" size="sm" onClick={() => void load()} className="max-md:h-11" data-testid="settings-opencode-providers-load">
            {t("settings.opencode.providers.show")}
          </Button>
        </div>
      )}
      {loadError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="min-w-0 flex-1 text-destructive text-sm">
            {loadError}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()} className="max-md:h-11" data-testid="settings-opencode-providers-load">
            {t("settings.opencode.providers.retry")}
          </Button>
        </div>
      )}
      {providers && !provider && (
        <>
          {connected.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 py-1" data-testid="settings-opencode-provider-row" data-provider-id={p.id} data-connected="true">
              <span className="min-w-0 flex-1 break-words text-sm">{p.name}</span>
              <span className="text-muted-foreground text-xs" data-testid="settings-opencode-provider-status">
                {statusText(p)}
              </span>
              {(p.source === "api" || p.source === "custom") && (
                <Button variant="outline" size="sm" onClick={() => setLogout(p)} className="max-md:h-11" data-testid="settings-opencode-logout" data-provider-id={p.id}>
                  {t("settings.opencode.providers.logout")}
                </Button>
              )}
            </div>
          ))}
          {!connected.length && (
            <div className="flex flex-wrap items-center gap-2 py-1">
              <p className="min-w-0 flex-1 text-sm text-muted-foreground" data-testid="settings-opencode-providers-empty">
                {t("settings.opencode.providers.empty")}
              </p>
              <Button variant="secondary" size="sm" onClick={() => search.current?.focus()} className="max-md:h-11" data-testid="settings-opencode-providers-connect">
                {t("settings.opencode.providers.connectAProvider")}
              </Button>
            </div>
          )}
          <label className="flex flex-col gap-1 pt-2">
            <span className="text-sm">{t("settings.opencode.providers.search")}</span>
            <input ref={search} value={query} onChange={(e) => setQuery(e.target.value)} className={input} autoComplete="off" spellCheck={false} data-testid="settings-opencode-connect-search" />
          </label>
          <div className="mt-1 max-h-80 overflow-y-auto rounded-md border">
            {rows.map((p) => (
              <button key={p.id} type="button" onClick={() => open(p)} className="flex min-h-8 w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11" data-testid="settings-opencode-connect-row" data-provider-id={p.id}>
                <span className="min-w-0 flex-1 break-words">{p.name}</span>
                <span className="text-muted-foreground text-xs">{t("settings.opencode.providers.connect")}</span>
              </button>
            ))}
            {!rows.length && <p className="px-2 py-2 text-muted-foreground text-sm">{t("settings.opencode.providers.noMatch")}</p>}
          </div>
        </>
      )}
      {provider && m && (
        <form
          className="flex flex-col gap-2"
          noValidate
          onSubmit={(e) => (e.preventDefault(), phase.kind === "oauth" ? phase.start.mode === "code" && (!code.trim() ? setFail({ field: "code", text: t("settings.opencode.providers.enter", { what: t("settings.opencode.providers.code") }) }) : (setFail(undefined), finish(provider.id, provider.name, method, code.trim()))) : submit())}
          data-testid="settings-opencode-connect-form"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h5 ref={heading} tabIndex={-1} className="min-w-0 flex-1 font-medium text-sm outline-none">{t("settings.opencode.providers.connectTo", { name: provider.name })}</h5>
            <Button type="button" variant="ghost" size="sm" onClick={() => (close(), setTimeout(() => search.current?.focus()))} className="max-md:h-11">
              {t("settings.opencode.providers.back")}
            </Button>
          </div>
          {phase.kind !== "oauth" && provider.methods.length > 1 && (
            <fieldset className="flex flex-col gap-1">
              <legend className="pb-1 text-sm">{t("settings.opencode.providers.method")}</legend>
              {provider.methods.map((x, i) => (
                <label key={i} className="flex min-h-8 items-center gap-2 text-sm max-md:min-h-11">
                  <input type="radio" name="opencode-method" checked={i === method} onChange={() => pick(i)} disabled={phase.kind === "busy"} data-testid="settings-opencode-method" />
                  {x.label}
                </label>
              ))}
            </fieldset>
          )}
          {phase.kind !== "oauth" &&
            vis.map((p) => (
              <label key={p.key} className="flex flex-col gap-1">
                <span className="text-sm">{p.message}</span>
                {p.type === "select" ? (
                  <select value={values[p.key] ?? ""} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} className={input} data-testid={`settings-opencode-prompt-${p.key}`}>
                    {p.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={values[p.key] ?? ""} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} placeholder={p.placeholder} className={input} autoComplete="off" {...errProps(p.key, `opencode-prompt-${p.key}-error`)} data-testid={`settings-opencode-prompt-${p.key}`} />
                )}
                {err(p.key) && (
                  <span id={`opencode-prompt-${p.key}-error`} role="alert" className="text-destructive text-xs">
                    {err(p.key)}
                  </span>
                )}
              </label>
            ))}
          {m.type === "api" && (
            <label className="flex flex-col gap-1">
              <span className="text-sm">{t("settings.opencode.providers.apiKey")}</span>
              <input
                type="password"
                value={key}
                onChange={(e) => (setKey(e.target.value), fail?.field === "key" && setFail(undefined))}
                onBlur={() => setFail((f) => keyError() ?? (f?.field === "key" ? undefined : f))}
                autoComplete="off"
                spellCheck={false}
                disabled={phase.kind === "busy"}
                className={input}
                {...errProps("key", "opencode-key-error")}
                data-testid="settings-opencode-key"
              />
              {err("key") ? (
                <span id="opencode-key-error" role="alert" className="text-destructive text-xs" data-testid="settings-opencode-key-error">
                  {err("key")}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">{t("settings.opencode.providers.keyHint")}</span>
              )}
            </label>
          )}
          {phase.kind === "oauth" && !phase.unsafe && (
            <div className="flex flex-col gap-2">
              <p className="select-text whitespace-pre-wrap break-words text-sm">{phase.start.instructions}</p>
              {phase.start.mode === "auto" ? (
                <p role="status" className="flex items-center gap-2 text-muted-foreground text-sm" data-testid="settings-opencode-oauth-wait">
                  <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  {t("settings.opencode.providers.waiting")}
                </p>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-sm">{t("settings.opencode.providers.code")}</span>
                  <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} className={input} {...errProps("code", "opencode-code-error")} data-testid="settings-opencode-oauth-code" />
                  {err("code") && (
                    <span id="opencode-code-error" role="alert" className="text-destructive text-xs">
                      {err("code")}
                    </span>
                  )}
                </label>
              )}
              <a href={phase.start.url} target="_blank" rel="noopener noreferrer" className="text-sm underline max-md:inline-flex max-md:min-h-11 max-md:items-center">
                {t("settings.opencode.providers.again")}
              </a>
            </div>
          )}
          {phase.kind === "oauth" && phase.unsafe && <p className="select-text break-all text-sm">{phase.start.url}</p>}
          {fail && !fail.field && (
            <p role="alert" className="text-destructive text-sm" data-testid="settings-opencode-login-error">
              {fail.text}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {phase.kind === "oauth" ? (
              <>
                {phase.start.mode === "code" && !phase.unsafe && (
                  <Button type="submit" size="sm" className="max-md:h-11" data-testid="settings-opencode-login-submit">
                    {t("settings.opencode.providers.submit")}
                  </Button>
                )}
                <Button type="button" variant="outline" size="sm" onClick={cancel} className="max-md:h-11" data-testid="settings-opencode-login-cancel">
                  {t("sidebar.cancel")}
                </Button>
              </>
            ) : (
              <Button type="submit" size="sm" disabled={phase.kind === "busy"} aria-busy={phase.kind === "busy"} className="max-md:h-11" data-testid="settings-opencode-login-submit">
                {phase.kind === "busy" && <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" aria-hidden />}
                {t("settings.opencode.providers.submit")}
              </Button>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={!!logout}
        title={t("settings.opencode.providers.logoutTitle", { name: logout?.name ?? "" })}
        description={t("settings.opencode.providers.logoutBody", { name: logout?.name ?? "" })}
        confirm={t("settings.opencode.providers.logout")}
        destructive
        onConfirm={doLogout}
        onCancel={() => setLogout(undefined)}
        testId="settings-opencode-logout"
      />
    </div>
  );
}
