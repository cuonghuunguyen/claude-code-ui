// Settings > About (docs/spec.md "Settings"): which versions the user runs, as selectable text for bug reports. The daemon's version
// comes with the `settings.get` reply the dialog already holds. The Updates row checks on request (`update.check`) and shows the
// available version even after "Not yet" hid the notice (docs/spec.md "Updates").
import { useState } from "react";
import type { UpdateCheckResult } from "@claude-ui/protocol";
import type { Request, RequestError } from "./client.ts";
import { WEB_VERSION } from "./version.ts";
import { useT } from "./i18n.ts";
import { checkError, installUpdate, updateText, type UpdateInfo } from "./update.tsx";

const BUTTON = "h-7 shrink-0 rounded-md border px-2.5 text-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 max-md:h-11";

/** `onCheckUpdate`: App's check (it also brings the notice back); none: no Updates row. `update`: what the daemon announced. */
function UpdatesRow({ update, onCheckUpdate, request }: { update?: UpdateInfo; onCheckUpdate: () => Promise<UpdateCheckResult>; request?: (m: Request) => Promise<unknown> }) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ upToDate?: string; error?: string }>();
  const phase = update?.state?.phase;
  const check = () => {
    setChecking(true);
    setResult(undefined);
    onCheckUpdate()
      .then((r) => setResult(r.latest ? {} : { upToDate: r.current }))
      .catch((e: RequestError) => setResult({ error: checkError(e) }))
      .finally(() => setChecking(false));
  };
  const install = () => {
    setResult(undefined);
    // The notice shows the phases from here on; a failure also comes back as update_available.
    if (request) installUpdate(request).catch((e: Error) => e.message !== "disconnected" && setResult({ error: e.message }));
  };
  const status = checking
    ? t("app.update.checking")
    : result?.error
      ? result.error
      : update && phase
        ? updateText(update).title
        : update
          ? t("app.update.availableText", { version: update.version, current: update.current })
          : result?.upToDate
            ? t("app.update.upToDate", { version: result.upToDate })
            : t("about.autoCheck");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t py-2" data-testid="settings-about-updates">
      <div className="min-w-0 flex-1 max-md:basis-full">
        <span className="block text-sm">{t("about.updates")}</span>
        <span role="status" className="block text-muted-foreground text-xs [overflow-wrap:anywhere]">
          {status}
        </span>
      </div>
      {update && !phase && request && (
        <button type="button" className={BUTTON} onClick={install} data-testid="settings-about-update">
          {t("app.update.updateRestart")}
        </button>
      )}
      <button type="button" className={BUTTON} onClick={check} disabled={checking || !!phase} data-testid="settings-about-check">
        {t("about.check")}
      </button>
    </div>
  );
}

export function AboutSection({ daemonVersion, update, onCheckUpdate, request }: { daemonVersion?: string; update?: UpdateInfo; onCheckUpdate?: () => Promise<UpdateCheckResult>; request?: (m: Request) => Promise<unknown> }) {
  const t = useT();
  const row = (id: string, label: string, value: string) => (
    <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
      <span id={`settings-about-${id}-label`} className="min-w-0 flex-1 text-sm">{label}</span>
      <code aria-labelledby={`settings-about-${id}-label`} className="select-text rounded bg-muted px-1.5 py-0.5 font-mono text-xs" data-testid={`settings-about-${id}`}>{value}</code>
    </div>
  );
  return (
    <section aria-labelledby="settings-about" className="flex flex-col" data-testid="settings-about">
      <h3 id="settings-about" className="pb-1 font-medium text-[13px] text-muted-foreground">
        {t("about.title")}
      </h3>
      {row("web", t("about.web"), WEB_VERSION)}
      {daemonVersion && row("daemon", t("about.daemon"), daemonVersion)}
      {onCheckUpdate && <UpdatesRow update={update} onCheckUpdate={onCheckUpdate} request={request} />}
      <p className="pt-2 text-muted-foreground text-xs">{t("about.hint")}</p>
    </section>
  );
}
