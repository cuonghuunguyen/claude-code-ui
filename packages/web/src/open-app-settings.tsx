// Settings › Open in app (GH-646): the user's own editor command, shown as "Open in <name>" in the file menus (docs/spec.md "Settings").
// Same shape as the Jira fields: a draft per field, saved on blur or Enter, the daemon's message shown under the field.
import { useState } from "react";
import type { Settings, SettingsResult } from "@claude-ui/protocol";
import type { Request, RequestError } from "./client.ts";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";

type Key = keyof Settings["editor"];
type Props = {
  editor: Settings["editor"];
  saving: boolean;
  request: <T>(m: Request) => Promise<T>;
  onResult: (r: SettingsResult) => void;
  /** A failure that is not about the typed value (network, older daemon). */
  onError: (message: string) => void;
};

const INPUT = "h-8 w-full min-w-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:h-11 max-md:text-base";
const ROW = "flex flex-col gap-1 border-t py-2";

export function OpenAppSection({ editor, saving, request, onResult, onError }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<Partial<Record<Key, string>>>({});
  const [bad, setBad] = useState<Partial<Record<Key, string>>>({});

  const commit = async (k: Key) => {
    const v = draft[k]?.trim();
    if (v === undefined) return;
    const done = () => setDraft(({ [k]: _, ...rest }) => rest);
    if (v === editor[k]) return done();
    try {
      onResult(await request<SettingsResult>({ type: "settings.set", patch: { editor: { [k]: v } } }));
      setBad(({ [k]: _, ...rest }) => rest);
      done();
    } catch (e) {
      const { code, message } = e as RequestError;
      if (code === "bad_settings") setBad((b) => ({ ...b, [k]: message }));
      else if (code === "not_local") setBad((b) => ({ ...b, [k]: t("settings.openApp.notLocal") }));
      else onError(message);
    }
  };
  const field = (k: Key, o: { mono?: boolean }) => {
    const id = `settings-openapp-${k}`;
    return (
      <label className={ROW}>
        <span className="text-sm">{t(`settings.openApp.${k}`)}</span>
        <input
          type="text"
          value={draft[k] ?? editor[k]}
          placeholder={t(`settings.openApp.${k}Placeholder`)}
          onChange={(e) => (setDraft((d) => ({ ...d, [k]: e.target.value })), setBad(({ [k]: _, ...rest }) => rest))}
          onBlur={() => void commit(k)}
          onKeyDown={(e) => e.key === "Enter" && !isImeKey(e.nativeEvent) && (e.preventDefault(), e.currentTarget.blur())} // preventDefault: on a phone the focus falls to Back and this Enter would click it
          disabled={saving}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-invalid={bad[k] ? true : undefined}
          aria-describedby={bad[k] ? `${id}-hint ${id}-error` : `${id}-hint`}
          className={`${INPUT}${o.mono ? " font-mono" : ""}`}
          data-testid={id}
        />
        <span id={`${id}-hint`} className="text-muted-foreground text-xs">
          {t(`settings.openApp.${k}Hint`)}
        </span>
        {bad[k] && (
          <span id={`${id}-error`} role="alert" className="text-destructive text-xs" data-testid={`${id}-error`}>
            {bad[k]}
          </span>
        )}
      </label>
    );
  };

  return (
    <section aria-labelledby="settings-openapp" className="flex flex-col" data-testid="settings-openapp">
      <h3 id="settings-openapp" className="pb-1 font-medium text-[13px] text-muted-foreground">
        {t("settings.openApp.title")}
      </h3>
      {field("command", { mono: true })}
      {field("name", {})}
    </section>
  );
}
