// Project settings dialog (docs/spec.md "Project settings"): the settings of one Project that replace the global ones. One row pattern for
// every field: a control whose first option (or empty text) is "Global (<value>)", a Global / Project status in text, and a reset button
// while the Project sets it. A change is saved at once through settings.set (the whole overrides map, like labels).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_ENGINE, EFFORTS, jiraIsCloud, LOCAL_SIDE, SESSION_MODES, type ClaudeAccountInfo, type Effort, type Engine, type ModelInfo, type ProjectOverrides, type Settings, type SettingsPatch, type SettingsResult } from "@claude-ui/protocol";
import { RotateCcwIcon } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Request } from "./client.ts";
import { Banner, ConfigDialog } from "./config-dialog.tsx";
import { ENGINE_NAME } from "./engine-tag.tsx";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";
import { ProjectJiraToken } from "./project-jira-token.tsx";
import { jiraOf, jiraOriginOf, jiraTokenFor, overridesOf, setOverride } from "./project-settings.ts";
import { EFFORT_LABEL, MODE_LABEL } from "./toolbar.tsx";

const GLOBAL = "__global__";
const DEFAULT_ACCOUNT = "__default__";
const CONTROL = "w-44 max-md:w-full";
const INPUT = "h-8 min-w-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";

type Option = { value: string; label: string };
type Change = { [K in keyof ProjectOverrides]?: ProjectOverrides[K] | undefined };

type Props = {
  open: boolean;
  /** The Project (never a Worktree path: a Worktree reads its Project's entry). */
  cwd: string;
  name: string;
  /** Side id of the Project, `local` for this daemon. */
  side: string;
  /** Engines this Project's machine offers. */
  engines: Engine[];
  /** Models of an Engine for this Project (the model catalogue). */
  modelsOf: (engine: Engine) => ModelInfo[];
  /** Asks for the model list of an Engine that is fetched on demand. */
  loadModels: (engine: Engine) => void;
  request: <T>(msg: Request) => Promise<T>;
  /** Bumped when another client changed the settings. */
  changed?: number;
  onClose: () => void;
};

type Ui = { busy: boolean; error?: { id: string; message: string }; save: (id: string, change: Change) => void };
type Ids = { labelId: string; describedBy: string };

/** One row: label, hint, control, status and reset. `set`: the Project sets this field. */
function Row({ ui, id, label, hint, set, reset, children }: { ui: Ui; id: string; label: string; hint: string; set: boolean; reset: Change; children: (p: Ids) => ReactNode }) {
  const t = useT();
  const message = ui.error?.id === id ? ui.error.message : undefined;
  const describedBy = `${id}-hint${message ? ` ${id}-error` : ""}`;
  return (
    <div className="flex flex-col gap-1 border-t py-2" data-testid={id} data-set={set ? "project" : "global"}>
      <div className="flex gap-3 max-md:flex-col max-md:gap-1">
        <div className="min-w-0 flex-1">
          <span id={`${id}-label`} className="block text-sm">{label}</span>
          <span id={`${id}-hint`} className="block text-muted-foreground text-xs">{hint}</span>
        </div>
        <div className="flex items-center gap-2 max-md:w-full">
          {children({ labelId: `${id}-label`, describedBy })}
          <span className={`w-12 shrink-0 text-xs ${set ? "font-medium text-foreground" : "text-muted-foreground"}`} data-testid={`${id}-status`}>{set ? t("projectSettings.project") : t("projectSettings.global")}</span>
          <button
            type="button"
            disabled={!set || ui.busy}
            onClick={() => ui.save(id, reset)}
            aria-label={t("projectSettings.reset", { field: label })}
            title={t("projectSettings.reset", { field: label })}
            className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11 ${set ? "" : "invisible"}`}
            data-testid={`${id}-reset`}
            tabIndex={set ? 0 : -1}
          >
            <RotateCcwIcon className="size-4" aria-hidden />
          </button>
        </div>
      </div>
      {message && (
        <p role="alert" id={`${id}-error`} className="text-destructive text-xs" data-testid={`${id}-error`}>
          {message}
        </p>
      )}
    </div>
  );
}

/** Select whose first option is "Global (<value>)" = unset. */
function Choice({ ui, id, value, globalValue, options, onChange, p }: { ui: Ui; id: string; value: string | undefined; globalValue: string; options: Option[]; onChange: (v: string | undefined) => void; p: Ids }) {
  const t = useT();
  const shown = value ?? GLOBAL;
  const label = (v: string) => (v === GLOBAL ? t("projectSettings.globalValue", { value: globalValue }) : (options.find((x) => x.value === v)?.label ?? v));
  return (
    <Select value={shown} onValueChange={(v) => v && v !== shown && onChange(v === GLOBAL ? undefined : v)} disabled={ui.busy}>
      <SelectTrigger aria-labelledby={p.labelId} aria-describedby={p.describedBy} data-testid={`${id}-select`} className={`${CONTROL} max-md:data-[size=default]:h-11`}>
        <SelectValue>{(v: string) => label(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {[{ value: GLOBAL, label: label(GLOBAL) }, ...options].map((x) => (
          <SelectItem key={x.value} value={x.value} data-testid={`${id}-${x.value}`}>
            {x.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Text field: empty = unset; the global value is the placeholder. Saved on Enter or blur. */
function TextField({ ui, id, value, globalValue, onSave, p }: { ui: Ui; id: string; value: string | undefined; globalValue: string; onSave: (v: string | undefined) => void; p: Ids }) {
  const t = useT();
  const [text, setText] = useState<string>();
  const commit = () => {
    if (text === undefined) return;
    const next = text.trim();
    setText(undefined);
    if (next !== (value ?? "")) onSave(next || undefined);
  };
  return (
    <input
      type="text"
      aria-labelledby={p.labelId}
      aria-describedby={p.describedBy}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      value={text ?? value ?? ""}
      placeholder={t("projectSettings.globalValue", { value: globalValue || t("projectSettings.none") })}
      disabled={ui.busy}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), commit())}
      className={`${INPUT} ${CONTROL}`}
      data-testid={`${id}-input`}
    />
  );
}

export function ProjectSettingsDialog({ open, cwd, name, side, engines, modelsOf, loadModels, request, changed = 0, onClose }: Props) {
  const t = useT();
  const [settings, setSettings] = useState<Settings>();
  const [accounts, setAccounts] = useState<ClaudeAccountInfo[]>([]);
  const [envToken, setEnvToken] = useState(false);
  const [tokens, setTokens] = useState<Pick<SettingsResult, "jiraToken" | "jiraTokens">>({});
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<{ id: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const ask = useRef(request);
  ask.current = request;

  const take = (r: SettingsResult) => (setSettings(r.settings), setAccounts(r.claudeAccounts ?? []), setEnvToken(!!r.daemon?.claudeEnvToken), setTokens({ jiraToken: r.jiraToken, jiraTokens: r.jiraTokens }));
  useEffect(() => {
    if (!open) return;
    let live = true;
    ask.current<SettingsResult>({ type: "settings.get" }).then(
      (r) => live && (take(r), setError(undefined)),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [open, changed]);

  const all = settings?.projects?.overrides;
  const o: ProjectOverrides = overridesOf(all, side === LOCAL_SIDE ? {} : { [cwd]: side }, cwd);
  const globalEngine = settings?.sessions.engine ?? DEFAULT_ENGINE;
  const engine = o.engine ?? globalEngine;
  useEffect(() => {
    if (open && settings) loadModels(engine);
  }, [open, !!settings, engine]);

  const save = async (id: string, change: Change) => {
    setBusy(true);
    try {
      const patch = { projects: { overrides: setOverride(all, side, cwd, change) } } as SettingsPatch;
      take(await ask.current<SettingsResult>({ type: "settings.set", patch }));
      setFieldError(undefined);
    } catch (e) {
      setFieldError({ id, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const ui: Ui = { busy, error: fieldError, save: (id, change) => void save(id, change) };
  const section = (id: string, title: string, rows: ReactNode) => (
    <section aria-labelledby={`project-settings-${id}`} className="flex flex-col" data-testid={`project-settings-${id}`}>
      <h3 id={`project-settings-${id}`} className="pb-1 font-medium text-[13px] text-muted-foreground">
        {title}
      </h3>
      {rows}
    </section>
  );

  const modeOptions = SESSION_MODES.map((m) => ({ value: m, label: t(MODE_LABEL[m].label) }));
  const effortOptions = EFFORTS.filter((e) => e !== "default").map((e) => ({ value: e, label: t(EFFORT_LABEL[e]) }));
  const models = modelsOf(engine);
  const modelOptions = [...models.map((m) => ({ value: m.value, label: m.displayName })), ...(o.model && !models.some((m) => m.value === o.model) ? [{ value: o.model, label: o.model }] : [])];
  const accountName = (id: string) => (id === "cli" ? t("app.plan.accountCli") : id === "" ? t("app.plan.accountDefault") : (accounts.find((a) => a.id === id)?.name ?? id));
  const accountOptions = [...(envToken ? [{ value: DEFAULT_ACCOUNT, label: t("app.plan.accountDefault") }] : []), { value: "cli", label: t("app.plan.accountCli") }, ...accounts.map((a) => ({ value: a.id, label: a.name }))];
  const modeNow = settings?.sessions.defaultMode;
  // A model or effort belongs to an Engine: setting one pins the Engine the Project uses now, so a later change of the global Engine (the last one used) does not give it to another Engine.
  // Jira: the connection in effect, and who shares the token of its origin. Shown only when the daemon keeps a token per origin (`jiraTokens`).
  const jiraNow = settings?.jira ? jiraOf(all, side, cwd, settings.jira) : undefined;
  const jiraOrigin = jiraNow ? jiraOriginOf(jiraNow.url) : "";
  const others = Object.entries(all ?? {}).flatMap(([s, projects]) => Object.entries(projects).filter(([c, p]) => !(s === side && c === cwd) && p.jira?.url && jiraOriginOf(p.jira.url) === jiraOrigin));
  const sharedWith = [...(settings?.jira && jiraOriginOf(settings.jira.url) === jiraOrigin ? [t("projectSettings.jira.sharedGlobal")] : []), ...(others.length ? [t("projectSettings.jira.sharedProjects", { count: others.length })] : [])].join(", ");
  const pinEngine = (v: string | undefined): Change => (v !== undefined && o.engine === undefined ? { engine: globalEngine } : {});

  return (
    <ConfigDialog title={t("projectSettings.title", { name })} open={open} onClose={onClose} testId="project-settings-dialog">
      {error && <Banner kind="error">{error}</Banner>}
      {!settings && !error && <p className="text-muted-foreground text-sm">{t("settings.loading")}</p>}
      {settings && !settings.projects && <p className="text-muted-foreground text-sm" data-testid="project-settings-unsupported">{t("projectSettings.unsupported")}</p>}
      {settings?.projects && (
        <>
          <p className="text-muted-foreground text-xs">{t("projectSettings.intro")}</p>
          {section(
            "sessions",
            t("projectSettings.group.sessions"),
            <>
              <Row ui={ui} id="project-engine" label={t("projectSettings.engine.label")} hint={t("projectSettings.engine.hint")} set={o.engine !== undefined} reset={{ engine: undefined, model: undefined, effort: undefined }}>
                {(p) => (
                  <Choice
                    ui={ui}
                    id="project-engine"
                    p={p}
                    value={o.engine}
                    globalValue={ENGINE_NAME[globalEngine]}
                    options={engines.map((e) => ({ value: e, label: ENGINE_NAME[e] }))}
                    onChange={(v) => ui.save("project-engine", { engine: v as Engine | undefined, model: undefined, effort: undefined })}
                  />
                )}
              </Row>
              <Row ui={ui} id="project-model" label={t("projectSettings.model.label")} hint={t("projectSettings.model.hint")} set={o.model !== undefined} reset={{ model: undefined }}>
                {(p) => <Choice ui={ui} id="project-model" p={p} value={o.model} globalValue={t("projectSettings.default")} options={modelOptions} onChange={(v) => ui.save("project-model", { model: v, ...pinEngine(v) })} />}
              </Row>
              <Row ui={ui} id="project-effort" label={t("projectSettings.effort.label")} hint={t("projectSettings.effort.hint")} set={o.effort !== undefined} reset={{ effort: undefined }}>
                {(p) => <Choice ui={ui} id="project-effort" p={p} value={o.effort} globalValue={t("projectSettings.default")} options={effortOptions} onChange={(v) => ui.save("project-effort", { effort: v as Effort | undefined, ...pinEngine(v) })} />}
              </Row>
              <Row ui={ui} id="project-mode" label={t("projectSettings.mode.label")} hint={t("projectSettings.mode.hint")} set={o.mode !== undefined} reset={{ mode: undefined }}>
                {(p) => (
                  <Choice ui={ui} id="project-mode" p={p} value={o.mode} globalValue={modeNow ? t(MODE_LABEL[modeNow].label) : t("projectSettings.default")} options={modeOptions} onChange={(v) => ui.save("project-mode", { mode: v as ProjectOverrides["mode"] })} />
                )}
              </Row>
              {side === LOCAL_SIDE ? (
                <Row ui={ui} id="project-account" label={t("projectSettings.account.label")} hint={t("projectSettings.account.hint")} set={o.account !== undefined} reset={{ account: undefined }}>
                  {(p) => (
                    <Choice
                      ui={ui}
                      id="project-account"
                      p={p}
                      value={o.account === undefined ? undefined : o.account === "" ? DEFAULT_ACCOUNT : o.account}
                      globalValue={accountName(settings.claude?.account ?? "")}
                      options={accountOptions}
                      onChange={(v) => ui.save("project-account", { account: v === undefined ? undefined : v === DEFAULT_ACCOUNT ? "" : v })}
                    />
                  )}
                </Row>
              ) : (
                <p className="border-t py-2 text-muted-foreground text-xs" data-testid="project-account-side">{t("projectSettings.account.side")}</p>
              )}
            </>,
          )}
          {section(
            "inline",
            t("projectSettings.group.inline"),
            <>
              <Row ui={ui} id="project-inline-model" label={t("projectSettings.inlineModel.label")} hint={t("projectSettings.inlineModel.hint")} set={o.inlineTask?.model !== undefined} reset={{ inlineTask: { model: undefined } }}>
                {(p) => <TextField ui={ui} id="project-inline-model" value={o.inlineTask?.model} globalValue={settings.inlineTask?.model ?? ""} onSave={(v) => ui.save("project-inline-model", { inlineTask: { model: v } })} p={p} />}
              </Row>
              <Row ui={ui} id="project-inline-opencode" label={t("projectSettings.inlineOpenCode.label")} hint={t("projectSettings.inlineOpenCode.hint")} set={o.inlineTask?.openCodeModel !== undefined} reset={{ inlineTask: { openCodeModel: undefined } }}>
                {(p) => <TextField ui={ui} id="project-inline-opencode" value={o.inlineTask?.openCodeModel} globalValue={settings.inlineTask?.openCodeModel ?? ""} onSave={(v) => ui.save("project-inline-opencode", { inlineTask: { openCodeModel: v } })} p={p} />}
              </Row>
            </>,
          )}
          {section(
            "history",
            t("projectSettings.group.history"),
            <Row ui={ui} id="project-history" label={t("projectSettings.history.label")} hint={t("projectSettings.history.hint")} set={o.history?.enabled !== undefined} reset={{ history: { enabled: undefined } }}>
              {(p) => (
                <Choice
                  ui={ui}
                  id="project-history"
                  p={p}
                  value={o.history?.enabled === undefined ? undefined : o.history.enabled ? "on" : "off"}
                  globalValue={settings.history?.enabled === false ? t("projectSettings.off") : t("projectSettings.on")}
                  options={[
                    { value: "on", label: t("projectSettings.on") },
                    { value: "off", label: t("projectSettings.off") },
                  ]}
                  onChange={(v) => ui.save("project-history", { history: { enabled: v === undefined ? undefined : v === "on" } })}
                />
              )}
            </Row>,
          )}
          {tokens.jiraTokens && settings.jira && jiraNow &&
            section(
              "jira",
              t("projectSettings.group.jira"),
              <>
                <Row ui={ui} id="project-jira-url" label={t("jira.url")} hint={t("projectSettings.jira.url.hint")} set={o.jira?.url !== undefined} reset={{ jira: { url: undefined } }}>
                  {(p) => <TextField ui={ui} id="project-jira-url" value={o.jira?.url} globalValue={settings.jira.url} onSave={(v) => ui.save("project-jira-url", { jira: { url: v } })} p={p} />}
                </Row>
                {(jiraIsCloud(jiraNow.url) || o.jira?.email !== undefined) && (
                  <Row ui={ui} id="project-jira-email" label={t("jira.email")} hint={t("jira.emailHint")} set={o.jira?.email !== undefined} reset={{ jira: { email: undefined } }}>
                    {(p) => <TextField ui={ui} id="project-jira-email" value={o.jira?.email} globalValue={settings.jira.email} onSave={(v) => ui.save("project-jira-email", { jira: { email: v } })} p={p} />}
                  </Row>
                )}
                <ProjectJiraToken
                  key={`${side}|${cwd}|${jiraOrigin}`}
                  project={{ side, cwd }}
                  url={jiraNow.url}
                  own={o.jira?.url !== undefined}
                  cloud={jiraIsCloud(jiraNow.url)}
                  tokenSet={jiraTokenFor(tokens, jiraNow.url)}
                  sharedWith={sharedWith}
                  request={request}
                  onResult={take}
                />
                <Row ui={ui} id="project-jira-jql" label={t("jira.jql")} hint={t("projectSettings.jira.jql.hint")} set={o.jira?.jql !== undefined} reset={{ jira: { jql: undefined } }}>
                  {(p) => <TextField ui={ui} id="project-jira-jql" value={o.jira?.jql} globalValue={settings.jira.jql} onSave={(v) => ui.save("project-jira-jql", { jira: { jql: v } })} p={p} />}
                </Row>
                <Row ui={ui} id="project-jira-template" label={t("jira.template")} hint={t("jira.templateHint")} set={o.jira?.template !== undefined} reset={{ jira: { template: undefined } }}>
                  {(p) => <TextField ui={ui} id="project-jira-template" value={o.jira?.template} globalValue={settings.jira.template} onSave={(v) => ui.save("project-jira-template", { jira: { template: v } })} p={p} />}
                </Row>
              </>,
            )}
        </>
      )}
    </ConfigDialog>
  );
}

