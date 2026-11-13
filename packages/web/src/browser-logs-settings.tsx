// Settings > About > Browser logs (docs/spec.md "Browser logs"): the per-browser switch, entry count, export and clear.
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BUTTON } from "./about-settings.tsx";
import { browserLogs, logFileName, saveKeepLogs, useKeepLogs, type BrowserLogger } from "./browser-logs.ts";
import { downloadText } from "./download.ts";
import { useLocale, useT } from "./i18n.ts";
import { Switch } from "./plugins-dialog.tsx";

type Status = { count: number; oldest?: number; unavailable: boolean };

export function BrowserLogsSection({ logger = browserLogs }: { logger?: Pick<BrowserLogger, "stats" | "exportText" | "clear" | "state" | "setEnabled"> }) {
  const t = useT();
  const { locale } = useLocale();
  const keep = useKeepLogs();
  const [status, setStatus] = useState<Status>();
  const [confirm, setConfirm] = useState(false);
  const refresh = useCallback(() => {
    // `stats` flushes first, so entries logged a moment ago count; it also settles `state`.
    void logger.stats().then(
      (s) => setStatus({ ...s, unavailable: logger.state() === "unavailable" }),
      () => setStatus({ count: 0, unavailable: true }),
    );
  }, [logger]);
  useEffect(refresh, [refresh, keep]);

  const unavailable = status?.unavailable ?? false;
  const none = !status || status.count === 0;
  const text = unavailable
    ? t("browserLogs.unavailable")
    : !keep
      ? t("browserLogs.off")
      : !status
        ? ""
        : status.count === 0
          ? t("browserLogs.empty")
          : t("browserLogs.count", { count: status.count, oldest: status.oldest === undefined ? "" : new Date(status.oldest).toLocaleString(locale) });
  const exportLogs = () =>
    void logger.exportText().then((body) => {
      downloadText(logFileName(new Date()), body);
      refresh();
    });
  const clear = () => {
    setConfirm(false);
    void logger.clear().then(refresh, refresh);
  };

  return (
    <section aria-labelledby="settings-browser-logs" className="mt-4 flex flex-col" data-testid="settings-browser-logs">
      <h3 id="settings-browser-logs" className="pb-1 font-medium text-[13px] text-muted-foreground">
        {t("browserLogs.title")}
      </h3>
      <div className="flex items-center gap-3 border-t py-2">
        <div className="min-w-0 flex-1">
          <span className="block text-sm">{t("browserLogs.keep")}</span>
          <span id="settings-browser-logs-hint" className="block text-muted-foreground text-xs">
            {t("browserLogs.keepHint")}
          </span>
        </div>
        <Switch on={keep} label={t("browserLogs.keep")} held={false} onToggle={(on) => saveKeepLogs(on, logger as BrowserLogger)} title={t("browserLogs.keep")} describedBy="settings-browser-logs-hint" testId="settings-browser-logs-keep" />
      </div>
      <p role="status" className="border-t py-2 text-muted-foreground text-xs [overflow-wrap:anywhere]" data-testid="settings-browser-logs-status">
        {text}
      </p>
      <div className="flex flex-wrap items-center gap-2 border-t py-2">
        <button type="button" className={BUTTON} disabled={unavailable || none} onClick={exportLogs} data-testid="settings-browser-logs-export">
          {t("browserLogs.export")}
        </button>
        {!confirm && (
          <button type="button" className={BUTTON} disabled={unavailable || none} onClick={() => setConfirm(true)} data-testid="settings-browser-logs-clear">
            {t("browserLogs.clear")}
          </button>
        )}
        {confirm && (
          <div className="flex w-full flex-wrap items-center gap-2" data-testid="settings-browser-logs-clear-confirm">
            <span className="text-sm">{t("browserLogs.clearConfirm")}</span>
            <Button variant="destructive" className="max-md:h-11" onClick={clear} data-testid="settings-browser-logs-clear-yes">
              {t("browserLogs.clearYes")}
            </Button>
            <Button variant="secondary" className="max-md:h-11" onClick={() => setConfirm(false)} autoFocus>
              {t("browserLogs.cancel")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
