// "Manage addons" dialog (/addons; docs/spec.md "Frontend" › Addons dialog, ADR 0006): install from git or a local folder, approval card
// with the declared capabilities, enable, update check, uninstall, renderer conflicts and the per-addon log. State lives on the daemon (Hub).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";
import { capabilityDiff, capabilityLine, rendererConflicts, sourceText, type AddonInfo, type AddonLogEntry, type AddonUpdateCheck, type AddonsListResult } from "./addons.ts";
import { Switch } from "./plugins-dialog.tsx";

const INPUT = "h-9 w-full rounded-md bg-secondary/60 px-3 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary max-md:h-11 max-md:text-base";

/** `changed`: bumped on `config.changed` kind addons. `log`: the refused calls of this browser, by addon. */
export function AddonsDialog({ open, changed = 0, log, onClearLog, request, onClose }: { open: boolean; changed?: number; log?: Map<string, AddonLogEntry[]>; onClearLog?: (name: string) => void; request: <T>(msg: Request) => Promise<T>; onClose: () => void }) {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [list, setList] = useState<AddonsListResult>({ addons: [], picks: {} });
  const [kind, setKind] = useState<"git" | "local">("git");
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [path, setPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  /** The addon just installed: its approval card shows instead of its row. */
  const [fresh, setFresh] = useState<string>();
  const [checks, setChecks] = useState<Record<string, AddonUpdateCheck>>({});
  const [confirmRemove, setConfirmRemove] = useState<string>();
  const [working, setWorking] = useState<string>();

  const ask = useRef(request);
  ask.current = request;
  const sent = useRef(0);
  const load = async () => {
    const n = ++sent.current;
    try {
      const r = await ask.current<AddonsListResult>({ type: "addons.list" });
      if (n !== sent.current) return;
      setList(r);
      setLoadError(undefined);
    } catch (e) {
      if (n === sent.current) setLoadError((e as Error).message);
    } finally {
      if (n === sent.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(undefined);
    setNotice(undefined);
    setFresh(undefined);
    setChecks({});
    setConfirmRemove(undefined);
    void load();
  }, [open]);
  useEffect(() => void (open && changed && load()), [changed]);

  /** One write at a time: the buttons wait for it; the list is read again after. */
  async function act<T>(name: string, msg: Request, then?: (r: T) => void) {
    if (working) return;
    setError(undefined);
    setNotice(undefined);
    setWorking(name);
    try {
      const r = await request<T>(msg); // not `then?.(await …)`: optional call skips its arguments
      then?.(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(undefined);
    }
    await load();
  }
  async function install() {
    const source = kind === "git" ? { kind, url: url.trim(), ...(ref.trim() && { ref: ref.trim() }) } : { kind, path: path.trim() };
    if (installing || !(kind === "git" ? url.trim() : path.trim())) return;
    setError(undefined);
    setNotice(undefined);
    setInstalling(true);
    try {
      const a = await request<AddonInfo>({ type: "addons.install", source });
      setFresh(a.name);
      setUrl("");
      setRef("");
      setPath("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInstalling(false);
    }
    await load();
  }
  const approve = (a: AddonInfo) => act(a.name, { type: "addons.approve", name: a.name, capabilities: a.manifest!.capabilities }, () => setFresh(undefined));
  const uninstall = (name: string) => (setConfirmRemove(undefined), act(name, { type: "addons.uninstall", name }, () => (setFresh((f) => (f === name ? undefined : f)), setChecks(({ [name]: _, ...rest }) => rest))));
  const check = (name: string) =>
    act<AddonUpdateCheck>(name, { type: "addons.checkUpdate", name }, (r) => (r.latest === r.current ? setNotice(t("addons.upToDate", { name })) : setChecks((c) => ({ ...c, [name]: r }))));
  const update = (c: AddonUpdateCheck) => act(c.name, { type: "addons.update", name: c.name, sha: c.latest }, () => setChecks(({ [c.name]: _, ...rest }) => rest));

  const submitOnEnter = (e: React.KeyboardEvent) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), void install());
  const conflicts = rendererConflicts(list.addons);
  const freshAddon = list.addons.find((a) => a.name === fresh && a.state === "needs_approval" && a.manifest);
  const rows = list.addons.filter((a) => a !== freshAddon);

  const Caps = ({ caps }: { caps: string[] }) => (
    <ul className="flex flex-col gap-1 text-sm">
      {caps.map((c) => {
        const l = capabilityLine(c);
        return (
          <li key={c} className="[overflow-wrap:anywhere]" data-testid="addons-capability">
            {t(l.key, l.vars)}
          </li>
        );
      })}
    </ul>
  );
  const Heading = ({ children }: { children: ReactNode }) => <h4 className="mt-2 text-[13px] text-muted-foreground">{children}</h4>;

  const card = (a: AddonInfo) => {
    const m = a.manifest!;
    return (
      <section className="flex flex-col gap-1 rounded-lg border p-3" data-testid="addons-approve-card" aria-label={t("addons.approveTitle", { name: a.name })}>
        <h3 className="font-medium text-[14px]">{t("addons.approveTitle", { name: a.name })}</h3>
        <p className="text-muted-foreground text-xs">{[t("addons.version", { version: m.version }), m.description].filter(Boolean).join(" · ")}</p>
        <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{sourceText(a)}</p>
        <p className="text-sm">{t("addons.approveNote")}</p>
        <Heading>{t("addons.capabilities")}</Heading>
        <Caps caps={m.capabilities} />
        {m.themes.length > 0 && (
          <>
            <Heading>{t("addons.themes")}</Heading>
            <p className="text-sm">{m.themes.map((x) => x.name).join(", ")}</p>
          </>
        )}
        {m.views.length > 0 && (
          <>
            <Heading>{t("addons.views")}</Heading>
            <p className="text-sm">{m.views.map((v) => `${v.title} (${t(`addons.kind.${v.kind}`)})`).join(", ")}</p>
          </>
        )}
        {m.commands.length > 0 && (
          <>
            <Heading>{t("addons.commands")}</Heading>
            <p className="text-sm">{m.commands.map((c) => `/${a.name}:${c.name}`).join(", ")}</p>
          </>
        )}
        {m.renderers.length > 0 && (
          <>
            <Heading>{t("addons.renderers")}</Heading>
            <p className="text-sm">{m.renderers.map((r) => ("fence" in r ? `\`\`\`${r.fence}` : r.tool)).join(", ")}</p>
          </>
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button className="max-md:h-11" disabled={!!working} onClick={() => void approve(a)} data-testid="addons-approve">
            {t("addons.approve")}
          </Button>
          <Button variant="secondary" className="max-md:h-11" disabled={!!working} onClick={() => void uninstall(a.name)} data-testid="addons-cancel">
            {t("addons.cancel")}
          </Button>
        </div>
      </section>
    );
  };

  const row = (a: AddonInfo) => {
    const diff = a.manifest ? capabilityDiff(a.manifest.capabilities, a.approved) : { added: [], removed: [] };
    const entries = log?.get(a.name) ?? [];
    const c = checks[a.name];
    return (
      <li key={a.name} className="flex flex-col gap-1 rounded-md px-3 py-2 hover:bg-secondary/50" data-testid="addons-row" data-name={a.name}>
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2 font-medium text-[13px]">
              <span className="[overflow-wrap:anywhere]">{a.name}</span>
              {a.manifest && <span className="font-normal text-muted-foreground text-xs">{a.manifest.version}</span>}
              <span className={cn("rounded px-1.5 py-0.5 font-normal text-xs ring-1 ring-border", a.state === "error" && "text-destructive", a.state === "needs_approval" && "text-warning")} data-testid="addons-state">
                {t(`addons.state.${a.state}`)}
              </span>
            </div>
            {a.manifest?.description && <p className="text-muted-foreground text-xs leading-4">{a.manifest.description}</p>}
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{sourceText(a)}</p>
            {a.state === "error" && (
              <p className="text-destructive text-xs" data-testid="addons-error">
                {a.error}
              </p>
            )}
            {a.state === "needs_approval" && (
              <div className="flex flex-col gap-1 text-xs" data-testid="addons-diff">
                <p>{t("addons.needsApprovalNote")}</p>
                {diff.added.map((x) => (
                  <p key={`+${x}`} className="[overflow-wrap:anywhere]">
                    + {x}
                  </p>
                ))}
                {diff.removed.map((x) => (
                  <p key={`-${x}`} className="[overflow-wrap:anywhere]">
                    − {x}
                  </p>
                ))}
                <div>
                  <Button size="sm" className="max-md:h-11" disabled={!!working} onClick={() => void approve(a)} data-testid="addons-approve">
                    {t("addons.approve")}
                  </Button>
                </div>
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {(a.state === "enabled" || a.state === "disabled") && (
              <Switch on={a.state === "enabled"} label={t("addons.enable", { name: a.name })} held={!!working} onToggle={(enabled) => void act(a.name, { type: "addons.setEnabled", name: a.name, enabled })} testId="addons-enabled" />
            )}
            {a.source.kind === "git" && a.state !== "error" && (
              <Button variant="ghost" size="sm" className="text-muted-foreground max-md:h-11" disabled={!!working} onClick={() => void check(a.name)} data-testid="addons-check-update">
                {t("addons.checkUpdate")}
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" aria-label={t("addons.uninstall", { name: a.name })} title={t("addons.uninstall", { name: a.name })} disabled={!!working} onClick={() => setConfirmRemove(a.name)} className="text-muted-foreground max-md:size-11" data-testid="addons-uninstall">
              <Trash2Icon />
            </Button>
          </div>
        </div>
        {confirmRemove === a.name && (
          <div className="flex flex-wrap items-center gap-2" data-testid="addons-remove-confirm">
            <span className="text-sm">{t("addons.confirmUninstall", { name: a.name })}</span>
            <Button variant="destructive" className="max-md:h-11" autoFocus onClick={() => void uninstall(a.name)} data-testid="addons-remove">
              {t("addons.remove")}
            </Button>
            <Button variant="secondary" className="max-md:h-11" onClick={() => setConfirmRemove(undefined)}>
              {t("addons.cancel")}
            </Button>
          </div>
        )}
        {c && (
          <div className="flex flex-col gap-1 rounded-md border p-2 text-xs" data-testid="addons-update-card">
            <p className="font-medium">{t("addons.updateTitle", { name: a.name, current: c.current.slice(0, 7), latest: c.latest.slice(0, 7) })}</p>
            {c.error && <p className="text-destructive">{t("addons.updateError", { error: c.error })}</p>}
            {c.added.map((x) => (
              <p key={`+${x}`} className="[overflow-wrap:anywhere]">
                + {x}
              </p>
            ))}
            {c.removed.map((x) => (
              <p key={`-${x}`} className="[overflow-wrap:anywhere]">
                − {x}
              </p>
            ))}
            <div>
              <Button size="sm" className="max-md:h-11" disabled={!!working || !!c.error} onClick={() => void update(c)} data-testid="addons-update">
                {t("addons.update")}
              </Button>
            </div>
          </div>
        )}
        {entries.length > 0 && (
          <details className="text-xs" data-testid="addons-log">
            <summary className="cursor-pointer text-muted-foreground">{t("addons.log", { count: entries.length })}</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {entries.map((e, i) => (
                <li key={i} className={cn("[overflow-wrap:anywhere] font-mono", e.level === "error" ? "text-destructive" : e.level === "warn" && "text-warning")} data-testid="addons-log-entry" data-level={e.level}>
                  {new Date(e.at).toLocaleTimeString()} [{e.level}] {e.text}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="ghost" className="mt-1 max-md:h-11" onClick={() => onClearLog?.(a.name)} data-testid="addons-log-clear">
              {t("addons.logClear")}
            </Button>
          </details>
        )}
      </li>
    );
  };

  return (
    <ConfigDialog title={t("addons.title")} open={open} onClose={onClose} busy={installing} testId="addons-dialog">
      <section className="flex flex-col gap-2" aria-label={t("addons.installTitle")}>
        <div role="radiogroup" aria-label={t("addons.installTitle")} className="flex gap-1">
          {(["git", "local"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn("flex h-7 items-center rounded-md px-2.5 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:h-11", kind === k && "bg-secondary text-foreground")}
              data-testid={`addons-source-${k}`}
            >
              {k === "git" ? t("addons.sourceGit") : t("addons.sourceLocal")}
            </button>
          ))}
        </div>
        {kind === "git" ? (
          <div className="flex flex-wrap gap-2">
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("addons.urlPlaceholder")} aria-label={t("addons.url")} autoComplete="off" spellCheck={false} className={cn(INPUT, "min-w-0 flex-[3_1_14rem]")} data-testid="addons-url" />
            <input type="text" value={ref} onChange={(e) => setRef(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("addons.refPlaceholder")} aria-label={t("addons.ref")} autoComplete="off" spellCheck={false} className={cn(INPUT, "min-w-0 flex-[1_1_9rem]")} data-testid="addons-ref" />
          </div>
        ) : (
          <input type="text" value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("addons.pathPlaceholder")} aria-label={t("addons.path")} autoComplete="off" spellCheck={false} className={INPUT} data-testid="addons-path" />
        )}
        <div>
          <Button className="max-md:h-11" disabled={installing || !!working || !(kind === "git" ? url.trim() : path.trim())} onClick={() => void install()} data-testid="addons-install">
            {installing ? t("addons.installing") : t("addons.install")}
          </Button>
        </div>
      </section>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="success">{notice}</Banner>}
      {freshAddon && card(freshAddon)}
      {loading ? (
        <p className="text-muted-foreground text-sm">{t("addons.loading")}</p>
      ) : loadError ? (
        <Banner kind="error">{t("addons.loadFailed", { error: loadError })}</Banner>
      ) : rows.length === 0 && !freshAddon ? (
        <p className="text-muted-foreground text-sm">{t("addons.none")}</p>
      ) : (
        rows.length > 0 && (
          <section className="flex flex-col gap-px">
            <h3 className="my-1.5 px-3 text-[13px] text-muted-foreground leading-4">{t("addons.installed")}</h3>
            <ul className="flex flex-col gap-px">{rows.map(row)}</ul>
          </section>
        )
      )}
      {Object.keys(conflicts).length > 0 && (
        <section className="flex flex-col gap-2" data-testid="addons-conflicts">
          <h3 className="px-3 text-[13px] text-muted-foreground leading-4">{t("addons.conflicts")}</h3>
          {Object.entries(conflicts).map(([target, names]) => (
            <label key={target} className="flex flex-wrap items-center gap-2 px-3 text-sm">
              <span className="[overflow-wrap:anywhere]">{t("addons.conflictFor", { target })}</span>
              <select
                value={names.includes(list.picks[target] ?? "") ? list.picks[target] : names[0]}
                onChange={(e) => void act("pick", { type: "addons.pickRenderer", target, name: e.target.value })}
                className="h-9 rounded-md bg-secondary/60 px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
                data-testid={`addons-pick-${target}`}
              >
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
      )}
    </ConfigDialog>
  );
}
