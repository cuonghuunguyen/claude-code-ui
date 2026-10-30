// Settings › Jira (GH-447, docs/spec.md "Settings"): one app-wide Jira connection for the Create worktree modal's Ticket tab.
// URL, email and branch template are daemon settings (settings.json); the token is write-only (secrets.json): this page only
// learns whether one is set, with Replace and Clear.
import { useState } from "react";
import { jiraIsCloud, jiraUrlProblem, MY_OPEN_JQL, type Settings, type SettingsPatch, type SettingsResult } from "@claude-ui/protocol";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Request } from "./client.ts";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";

type Props = {
  jira: Settings["jira"];
  tokenSet: boolean;
  /** An old-format token was cleared by a security update (GH-487); shown until a token is saved. */
  tokenReset?: boolean;
  saving: boolean;
  save: (patch: SettingsPatch, field?: string) => Promise<void>;
  request: <T>(m: Request) => Promise<T>;
  /** After a token change: the dialog takes the reply (settings and `jiraToken`). */
  onResult: (r: SettingsResult) => void;
  onError: (message: string) => void;
};

const INPUT = "h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
const ROW = "flex flex-col gap-1 border-t py-2";

export function JiraSection({ jira, tokenSet, tokenReset, saving, save, request, onResult, onError }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Record<"url" | "email" | "template" | "jql", string>>>({});
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string }>();
  const url = draft.url ?? jira.url;
  const cloud = jiraIsCloud(url);

  const commit = (k: "url" | "email" | "template" | "jql") => {
    const v = draft[k];
    if (v === undefined) return;
    setTest(undefined);
    void save({ jira: { [k]: v.trim() } }).then(() => setDraft(({ [k]: _, ...rest }) => rest));
  };
  const field = (k: "url" | "email" | "template" | "jql", label: string, hint: string, o: { type?: string; placeholder?: string } = {}) => (
    <label className={ROW}>
      <span className="text-sm">{label}</span>
      <input
        type={o.type ?? "text"}
        value={draft[k] ?? jira[k] ?? ""}
        placeholder={o.placeholder}
        onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
        onBlur={() => commit(k)}
        onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), e.currentTarget.blur())} // preventDefault: on a phone the focus falls to Back and this Enter would click it
        disabled={saving}
        className={INPUT}
        aria-describedby={`settings-jira-${k}-hint`}
        data-testid={`settings-jira-${k}`}
      />
      <span id={`settings-jira-${k}-hint`} className="text-muted-foreground text-xs">
        {hint}
      </span>
      {k === "url" && jiraUrlProblem(jira.url) && (
        <span role="alert" className="text-destructive text-xs" data-testid="settings-jira-url-error">
          {t("common.jira.httpsRule")}
        </span>
      )}
    </label>
  );

  const setTokenTo = async (value: string | null) => {
    setBusy(true);
    setTest(undefined);
    try {
      onResult(await request<SettingsResult>({ type: "jira.token", token: value }));
      setReplacing(false);
      setToken("");
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async () => {
    setBusy(true);
    setTest(undefined);
    try {
      const r = await request<{ user: string }>({ type: "jira.test" });
      setTest({ ok: true, text: t("jira.connectedAs", { user: r.user }) });
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="settings-jira" className="flex flex-col" data-testid="settings-jira">
      <h3 id="settings-jira" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Jira
      </h3>
      {field("url", t("jira.url"), t("jira.urlHint"), { type: "url", placeholder: "https://acme.atlassian.net" })}
      {cloud && field("email", t("jira.email"), t("jira.emailHint"), { type: "email" })}
      <div className={ROW}>
        <span id="settings-jira-token-label" className="text-sm">
          {cloud ? t("jira.apiToken") : t("jira.pat")}
        </span>
        {tokenSet && !replacing ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 text-sm" data-testid="settings-jira-token-set">
              {t("jira.tokenSet")}
            </span>
            <Button variant="outline" size="sm" className="cursor-pointer max-md:h-11" disabled={busy} onClick={() => setReplacing(true)} data-testid="settings-jira-token-replace">
              {t("jira.replace")}
            </Button>
            <Button variant="destructive" size="sm" className="cursor-pointer max-md:h-11" disabled={busy} onClick={() => void setTokenTo(null)} data-testid="settings-jira-token-clear">
              {t("jira.clear")}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && token.trim() && void setTokenTo(token.trim())}
              aria-labelledby="settings-jira-token-label"
              aria-describedby="settings-jira-token-hint"
              className={INPUT}
              data-testid="settings-jira-token"
            />
            <Button size="sm" className="cursor-pointer max-md:h-11" disabled={busy || !token.trim()} onClick={() => void setTokenTo(token.trim())} data-testid="settings-jira-token-save">
              {t("jira.save")}
            </Button>
            {replacing && (
              <Button variant="ghost" size="sm" className="cursor-pointer max-md:h-11" onClick={() => (setReplacing(false), setToken(""))} data-testid="settings-jira-token-cancel">
                {t("jira.cancel")}
              </Button>
            )}
          </div>
        )}
        {tokenReset && !tokenSet && (
          <span role="status" className="text-xs" data-testid="settings-jira-token-reset">
            {t("jira.tokenReset")}
          </span>
        )}
        <span id="settings-jira-token-hint" className="text-muted-foreground text-xs">
          {t("jira.tokenHint", { create: cloud ? t("jira.createCloud") : t("jira.createServer") })}
        </span>
      </div>
      {field("template", t("jira.template"), t("jira.templateHint"))}
      {field("jql", t("jira.jql"), t("jira.jqlHint"), { placeholder: MY_OPEN_JQL })}
      <div className="flex flex-wrap items-center gap-2 border-t py-2">
        <Button variant="outline" size="sm" className="cursor-pointer max-md:h-11" disabled={busy || !jira.url || !tokenSet} onClick={() => void testConnection()} data-testid="settings-jira-test">
          {busy && <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {t("jira.test")}
        </Button>
        {test && (
          <span role={test.ok ? "status" : "alert"} className={`min-w-0 flex-1 text-sm ${test.ok ? "" : "text-destructive"}`} data-testid="settings-jira-test-result">
            {test.text}
          </span>
        )}
      </div>
    </section>
  );
}
