// Settings › Claude account (GH-615, docs/spec.md "Settings"): picks the account the daemon's Claude CLI processes use (Default, CLI login, a token account),
// runs the CLI login, and keeps token accounts. A token (from `claude setup-token`) is write-only: this page never shows one.
import { useState } from "react";
import type { ClaudeAccountInfo, SettingsResult } from "@claude-ui/protocol";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Request } from "./client.ts";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";

const INPUT = "h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";
const ROW = "flex items-center gap-2 border-t py-1 max-md:min-h-11";

export function ClaudeAccountSection({ active, accounts, envToken, request, onResult, onError, onLogin }: { active: string; accounts: ClaudeAccountInfo[]; envToken: boolean; request: <T>(msg: Request) => Promise<T>; onResult: (r: SettingsResult) => void; onError: (m: string) => void; onLogin: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (msg: Request, done?: () => void) => {
    setBusy(true);
    try {
      onResult(await request<SettingsResult>(msg));
      done?.();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = (id: string) => void run({ type: "settings.set", patch: { claude: { account: id } } });
  const choices = [...(envToken ? [{ id: "", name: t("app.plan.accountDefault") }] : []), { id: "cli", name: t("app.plan.accountCli") }, ...accounts];
  const add = () => name.trim() && token.trim() && void run({ type: "claude.account.add", name: name.trim(), token: token.trim() }, () => (setName(""), setToken("")));
  const btn = "cursor-pointer max-md:h-11";
  return (
    <section aria-labelledby="settings-account" className="flex flex-col" data-testid="settings-account">
      <h3 id="settings-account" className="pb-1 font-medium text-[13px] text-muted-foreground">
        {t("settings.account.title")}
      </h3>
      <div role="radiogroup" aria-label={t("app.plan.accountsLabel")} className="flex flex-col" data-testid="settings-account-list">
        {choices.map((c) => {
          const on = c.id === active || (!envToken && active === "" && c.id === "cli");
          const own = accounts.some((a) => a.id === c.id);
          return (
            <div key={c.id || "default"} className={ROW}>
              <button type="button" role="radio" aria-checked={on} disabled={busy} onClick={() => !on && pick(c.id)} data-testid="settings-account-option" className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:h-11">
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {own && <span className="text-muted-foreground text-xs" data-testid="settings-account-token-set">{t("settings.account.tokenSet")}</span>}
                {on && <CheckIcon className="size-3.5 shrink-0" aria-hidden />}
              </button>
              {own && (
                <Button variant="destructive" size="sm" className={btn} disabled={busy} onClick={() => void run({ type: "claude.account.remove", id: c.id })} data-testid="settings-account-remove">
                  {t("settings.account.remove")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <div className={ROW}>
        <div className="min-w-0 flex-1">
          <span className="block text-sm">{t("settings.account.login")}</span>
          <span id="settings-account-hint" className="block text-muted-foreground text-xs">{t("settings.account.loginHint")}</span>
        </div>
        <button type="button" onClick={onLogin} aria-describedby="settings-account-hint" className="h-8 rounded-md border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" data-testid="settings-claude-login">
          {t("settings.account.loginAction")}
        </button>
      </div>
      <div className="flex flex-col gap-2 border-t py-2">
        <span className="text-sm">{t("settings.account.add")}</span>
        <div className="flex items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t("settings.account.name")} aria-label={t("settings.account.name")} className={INPUT} data-testid="settings-account-name" />
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && add()}
            placeholder={t("settings.account.token")}
            aria-label={t("settings.account.token")}
            aria-describedby="settings-account-token-hint"
            className={INPUT}
            data-testid="settings-account-token"
          />
          <Button size="sm" className={btn} disabled={busy || !name.trim() || !token.trim()} onClick={add} data-testid="settings-account-add">
            {t("settings.account.addAction")}
          </Button>
        </div>
        <span id="settings-account-token-hint" className="text-muted-foreground text-xs">{t("settings.account.tokenHint")}</span>
        <span className="text-muted-foreground text-xs">{t("settings.account.cloudHint")}</span>
      </div>
    </section>
  );
}
