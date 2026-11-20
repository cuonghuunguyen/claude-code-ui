// Jira token of the Project settings dialog (docs/spec.md "Project settings"): the token belongs to the origin of the Project's own Jira URL, so
// Projects of one Jira site share it. Write-only like Settings › Jira: the page learns only whether one is saved. A Project without its own URL uses
// the global token and cannot change it here.
import { useState } from "react";
import { LoaderCircleIcon } from "lucide-react";
import type { ProjectRef, SettingsResult } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { Request } from "./client.ts";
import { useT } from "./i18n.ts";
import { isImeKey } from "./ime.ts";
import { ConfirmDialog } from "./session-actions.tsx";
import { jiraOriginOf } from "./project-settings.ts";

const INPUT = "h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
const BUTTON = "cursor-pointer max-md:h-11";

type Props = {
  project: ProjectRef;
  /** The Jira URL in effect for the Project. */
  url: string;
  /** The Project sets this URL itself. */
  own: boolean;
  cloud: boolean;
  /** A token is saved for the origin of `url`. */
  tokenSet: boolean;
  /** Who else uses this origin's token, as text ("" = nobody). */
  sharedWith: string;
  request: <T>(m: Request) => Promise<T>;
  /** After a token change: the dialog takes the reply. */
  onResult: (r: SettingsResult) => void;
};

export function ProjectJiraToken({ project, url, own, cloud, tokenSet, sharedWith, request, onResult }: Props) {
  const t = useT();
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string>();
  const [test, setTest] = useState<{ ok: boolean; text: string }>();
  const origin = jiraOriginOf(url);
  const label = cloud ? t("jira.apiToken") : t("jira.pat");

  const save = async (value: string | null) => {
    setBusy(true);
    setTest(undefined);
    try {
      onResult(await request<SettingsResult>({ type: "jira.token", token: value, project }));
      setReplacing(false);
      setToken("");
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async () => {
    setBusy(true);
    setTesting(true);
    setTest(undefined);
    try {
      const r = await request<{ user: string }>({ type: "jira.test", project });
      setTest({ ok: true, text: t("jira.connectedAs", { user: r.user }) });
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      setTesting(false);
    }
  };

  if (!own)
    return (
      <p className="border-t py-2 text-muted-foreground text-xs" data-testid="project-jira-token-global">
        {t("projectSettings.jira.tokenGlobal")}
      </p>
    );
  return (
    <div className="flex flex-col gap-1 border-t py-2" data-testid="project-jira-token-row">
      <span id="project-jira-token-label" className="text-sm">
        {label}
      </span>
      <span role="status" className="text-muted-foreground text-xs" data-testid="project-jira-token-status">
        {t(tokenSet ? "projectSettings.jira.tokenFor" : "projectSettings.jira.noTokenFor", { origin })}
      </span>
      {tokenSet && !replacing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" className={BUTTON} disabled={busy} onClick={() => setReplacing(true)} data-testid="project-jira-token-replace">
            {t("jira.replace")}
          </Button>
          <Button variant="destructive" size="sm" className={BUTTON} disabled={busy} onClick={() => (sharedWith ? setConfirmClear(true) : void save(null))} data-testid="project-jira-token-clear">
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
            onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && token.trim() && void save(token.trim())}
            aria-labelledby="project-jira-token-label"
            aria-describedby={`project-jira-token-hint${error ? " project-jira-token-error" : ""}`}
            className={INPUT}
            data-testid="project-jira-token"
          />
          <Button size="sm" className={BUTTON} disabled={busy || !token.trim()} onClick={() => void save(token.trim())} data-testid="project-jira-token-save">
            {t("jira.save")}
          </Button>
          {replacing && (
            <Button variant="ghost" size="sm" className={BUTTON} onClick={() => (setReplacing(false), setToken(""))} data-testid="project-jira-token-cancel">
              {t("jira.cancel")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" id="project-jira-token-error" className="text-destructive text-xs" data-testid="project-jira-token-error">
          {error}
        </p>
      )}
      <span id="project-jira-token-hint" className="text-muted-foreground text-xs">
        {t("jira.tokenHint", { create: cloud ? t("jira.createCloud") : t("jira.createServer") })}
      </span>
      {sharedWith && (
        <span className="text-muted-foreground text-xs" data-testid="project-jira-token-shared">
          {t("projectSettings.jira.shared", { with: sharedWith })}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="outline" size="sm" className={BUTTON} disabled={busy || !tokenSet} onClick={() => void testConnection()} data-testid="project-jira-test">
          {testing && <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" aria-hidden />}
          {t("jira.test")}
        </Button>
        {test && (
          <span role={test.ok ? "status" : "alert"} className={`min-w-0 flex-1 text-sm ${test.ok ? "" : "text-destructive"}`} data-testid="project-jira-test-result">
            {test.text}
          </span>
        )}
      </div>
      <ConfirmDialog
        open={confirmClear}
        title={t("projectSettings.jira.clearTitle", { origin })}
        description={t("projectSettings.jira.clearBody", { with: sharedWith })}
        confirm={t("jira.clear")}
        destructive
        testId="project-jira-clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => (setConfirmClear(false), void save(null))}
      />
    </div>
  );
}
