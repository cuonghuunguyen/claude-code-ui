// Settings › OpenCode (docs/spec.md "OpenCode engine"): the binary path (daemon setting `opencode.path`) and the status of that binary.
import { useEffect, useState } from "react";
import { OPENCODE_MIN, type OpenCodeStatus, type Settings, type SettingsPatch } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { Request } from "./client.ts";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";
import { OpenCodeProviders } from "./opencode-providers.tsx";

export function OpenCodeSection({ opencode, saving, save, request, onProviders }: { opencode: Settings["opencode"]; saving: boolean; /** `quiet`: a refusal throws and is not shown in the dialog banner (the caller shows it). */ save: (patch: SettingsPatch, field?: string, rethrow?: boolean, quiet?: boolean) => Promise<void>; request: <T>(m: Request) => Promise<T>; /** The provider set changed (login, logout): model lists of OpenCode are stale. */ onProviders?: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<string>();
  // The daemon alone judges the path (its platform decides what is absolute): its refusal shows under the field.
  const [invalid, setInvalid] = useState<string>();
  const [status, setStatus] = useState<OpenCodeStatus>();
  const [failed, setFailed] = useState<string>();
  const check = () => request<OpenCodeStatus>({ type: "opencode.status" }).then((s) => (setStatus(s), setFailed(undefined)), (e: Error) => setFailed(e.message));
  useEffect(() => void check(), []);
  const [restarting, setRestarting] = useState(false);
  // The daemon broadcasts opencode.providersChanged after the restart: the model lists reload from there.
  const restart = () => (setRestarting(true), request({ type: "opencode.restart" }).then(check, (e: Error) => setFailed(e.message)).finally(() => setRestarting(false)));

  const commit = () => {
    if (draft === undefined) return;
    const v = draft.trim();
    setInvalid(undefined);
    if (v === opencode.path) return setDraft(undefined);
    save({ opencode: { path: v } }, undefined, true, true).then(() => (setDraft(undefined), check()), (e: Error) => setInvalid(e.message));
  };
  const text = failed ?? (!status ? t("settings.opencode.checking") : status.state === "missing" ? t("settings.opencode.missing") : status.state === "old" ? t("settings.opencode.old", { version: status.version ?? "?", min: OPENCODE_MIN }) : status.state === "failed" ? (status.message ?? t("settings.opencode.failed")) : t(status.state === "running" ? "settings.opencode.running" : "settings.opencode.stopped", { version: status.version ?? "?" }));

  return (
    <section aria-labelledby="settings-opencode" className="flex flex-col" data-testid="settings-opencode">
      <h3 id="settings-opencode" className="pb-1 font-medium text-[13px] text-muted-foreground">
        OpenCode
      </h3>
      <label className="flex flex-col gap-1 border-t py-2">
        <span className="text-sm">{t("settings.opencode.path.label")}</span>
        <input
          value={draft ?? opencode.path}
          onChange={(e) => (setDraft(e.target.value), setInvalid(undefined))}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), e.currentTarget.blur())} // preventDefault: on a phone the focus falls to Back and this Enter would click it
          disabled={saving}
          aria-invalid={!!invalid}
          aria-describedby="settings-opencode-path-hint settings-opencode-path-error"
          className="h-8 w-full rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
          data-testid="settings-opencode-path"
        />
        <span id="settings-opencode-path-hint" className="text-muted-foreground text-xs">
          {t("settings.opencode.path.hint")}
        </span>
        {invalid && (
          <span id="settings-opencode-path-error" role="alert" className="text-destructive text-xs" data-testid="settings-opencode-path-error">
            {invalid}
          </span>
        )}
      </label>
      <div className="flex flex-wrap items-center gap-2 border-t py-2">
        <p className="min-w-0 flex-1 text-sm" role="status" data-testid="settings-opencode-status">
          {text}
        </p>
        <Button variant="secondary" size="sm" onClick={() => void check()} className="max-md:h-11" data-testid="settings-opencode-check">
          {t("settings.opencode.check")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void restart()} disabled={restarting} className="max-md:h-11" data-testid="settings-opencode-restart">
          {t("settings.opencode.restart")}
        </Button>
      </div>
      <OpenCodeProviders status={status} request={request} onProviders={onProviders ?? (() => {})} onLoaded={() => void check()} />
    </section>
  );
}
