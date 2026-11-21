// Write-only secrets (docs/spec.md "Settings", GH-447): secrets.json in the config dir (mode 0600), same JSON-file helper as settings.json.
// A secret is never sent in a reply, a broadcast or a log line; clients only learn whether one is set.
// Jira tokens are stored per origin (scheme + host + port) and only returned for that origin (GH-487, GH-894): Projects of one Jira site share
// one token. The token of the global URL's origin is also written as `jiraToken` + `jiraOrigin`, the format of older daemons sharing the file.
import { randomUUID } from "node:crypto";
import { createJsonFile } from "./json-file.ts";
import { LABEL_NAME_MAX } from "@claude-ui/protocol";
import { nameOk } from "./settings.ts";

// `legacy` lives in memory only: the file held a token without its origin (saved before GH-487).
/** A named Claude token (`claude setup-token`) the user pasted (GH-615); `token` leaves this file only as the env of a CLI process. */
type ClaudeAccount = { id: string; name: string; token: string };
export const CLAUDE_ACCOUNTS_MAX = 20;
type Stored = { jiraToken?: string; jiraOrigin?: string; jiraTokens?: Record<string, string>; jiraTokenReset?: true; legacy?: true; claudeAccounts?: ClaudeAccount[] };
const parse = (raw: unknown): Stored => {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accounts = (Array.isArray(r.claudeAccounts) ? r.claudeAccounts : [])
    .filter((a): a is ClaudeAccount => !!a && typeof a.id === "string" && !!a.id && nameOk(a.name) && typeof a.token === "string" && !tokenProblem(a.token))
    .slice(0, CLAUDE_ACCOUNTS_MAX);
  const listed = Object.fromEntries(Object.entries(r.jiraTokens && typeof r.jiraTokens === "object" && !Array.isArray(r.jiraTokens) ? r.jiraTokens : {}).filter(([, v]) => typeof v === "string" && v));
  // The old format wins for its origin: an older daemon may have replaced that token after this one wrote the map.
  const tokens: Record<string, string> = typeof r.jiraToken === "string" && r.jiraToken && typeof r.jiraOrigin === "string" ? { ...listed, [r.jiraOrigin]: r.jiraToken } : listed;
  const rest = { ...(accounts.length && { claudeAccounts: accounts }), ...(Object.keys(tokens).length && { jiraTokens: tokens }) };
  if (typeof r.jiraToken === "string" && r.jiraToken) return typeof r.jiraOrigin === "string" ? { jiraToken: r.jiraToken, jiraOrigin: r.jiraOrigin, ...rest } : { legacy: true, ...rest };
  return r.jiraTokenReset === true ? { jiraTokenReset: true, ...rest } : rest;
};
/** A Jira API token or personal access token: printable, no spaces, at most 2000 characters. */
export const tokenProblem = (t: unknown): string | undefined =>
  typeof t !== "string" || !t || t.length > 2000 || !/^[\x21-\x7e]+$/.test(t) ? "The token must be 1 to 2000 printable characters without spaces" : undefined;

const setTokens = (d: Stored, m: Record<string, string>) => void (Object.keys(m).length ? (d.jiraTokens = m) : delete d.jiraTokens);
/** The old format (`jiraToken` + `jiraOrigin`) holds the token of the global URL's origin, if there is one. */
function mirror(d: Stored, globalOrigin: string) {
  const t = d.jiraTokens;
  if (t && Object.hasOwn(t, globalOrigin)) (d.jiraToken = t[globalOrigin]), (d.jiraOrigin = globalOrigin);
  else delete d.jiraToken, delete d.jiraOrigin;
}

/** Without `file` the secrets live in memory only (tests). */
export function createSecrets({ file }: { file?: string } = {}) {
  const store = createJsonFile<Stored>(file, parse, "secrets");
  /** GH-487: an old-format token is removed from the disk in one atomic write and replaced by the persisted `jiraTokenReset` flag. */
  const get = (): Stored => {
    if (store.get().legacy) {
      try {
        store.change((d) => {
          delete d.legacy;
          d.jiraTokenReset = true;
        });
      } catch (e) {
        // The token is not returned anyway (no origin); the next read retries the write.
        console.error("could not remove the old-format Jira token from secrets.json:", (e as Error).message);
      }
    }
    return store.get();
  };
  return {
    /** The saved Claude token accounts; never the tokens. */
    claudeAccounts: (): { id: string; name: string }[] => (get().claudeAccounts ?? []).map(({ id, name }) => ({ id, name })),
    /** Every stored secret value, only to redact them from terminal output handed to an agent (agent-terminals.ts); never sent anywhere. */
    values: (): string[] => {
      const d = get();
      return [...new Set([...(d.jiraToken ? [d.jiraToken] : []), ...Object.values(d.jiraTokens ?? {})]), ...(d.claudeAccounts ?? []).map((a) => a.token)];
    },
    /** Only for the env of a CLI process. */
    claudeToken: (id: string): string | undefined => get().claudeAccounts?.find((a) => a.id === id)?.token,
    /** Returns the new id. Throws when the name or token is invalid or the list is full. */
    addClaudeAccount(name: string, token: string): string {
      if (!nameOk(name)) throw new Error(`The account name must be 1 to ${LABEL_NAME_MAX} characters without control characters`);
      const p = tokenProblem(token);
      if (p) throw new Error(p);
      const id = randomUUID();
      store.change((d) => {
        const list = d.claudeAccounts ?? [];
        if (list.length >= CLAUDE_ACCOUNTS_MAX) throw new Error(`At most ${CLAUDE_ACCOUNTS_MAX} Claude accounts`);
        d.claudeAccounts = [...list, { id, name, token }];
      });
      return id;
    },
    removeClaudeAccount: (id: string) => store.change((d) => void (d.claudeAccounts && (d.claudeAccounts = d.claudeAccounts.filter((a) => a.id !== id)))),
    /** The token, only for the origin it was saved for. */
    jiraToken: (origin: string): string | undefined => {
      const t = get().jiraTokens;
      return t && Object.hasOwn(t, origin) ? t[origin] : undefined;
    },
    /** The origins that have a saved token ("" = saved without URL); never the tokens. */
    jiraOrigins: (): string[] => Object.keys(get().jiraTokens ?? {}),
    /** An old-format token was removed and no token was saved since (Settings says why). */
    jiraTokenReset: (): boolean => !!get().jiraTokenReset,
    /**
     * Binds a token saved without URL to `origin` (the global URL's), in one write; no-op without such a token. It replaces a token a Project saved
     * for `origin` (GH-915): the token typed in Settings › Jira is the one the user means for the global URL.
     */
    bindJiraToken(origin: string) {
      const t = get().jiraTokens;
      if (!t || !Object.hasOwn(t, "") || origin === "") return;
      // Checked again on the freshly loaded data: another daemon may have written since `get()`.
      store.change((x) => {
        const m = x.jiraTokens;
        if (!m || !Object.hasOwn(m, "")) return;
        m[origin] = m[""]!;
        delete m[""];
        mirror(x, origin);
      });
    },
    /** The Jira URL was emptied: the "cleared by an update" notice has done its job. */
    endJiraTokenReset() {
      if (get().jiraTokenReset) store.change((d) => void (d.jiraTokenReset && delete d.jiraTokenReset));
    },
    /**
     * null clears. `origin` = the origin of the URL the token is for ("" without URL); `globalOrigin` = the origin of the global jira.url, whose token is
     * also kept in the old format. Throws when the token is invalid or the save fails.
     */
    setJiraToken(token: string | null, origin = "", globalOrigin = origin) {
      if (token !== null) {
        const p = tokenProblem(token);
        if (p) throw new Error(p);
      }
      store.change((d) => {
        delete d.jiraTokenReset;
        const m = Object.fromEntries(Object.entries(d.jiraTokens ?? {}).filter(([k]) => k !== origin));
        if (token !== null) m[origin] = token;
        setTokens(d, m);
        mirror(d, globalOrigin);
      });
    },
    /** Drops the tokens of the `drop` origins and keeps the old format on the global origin's token; no write when nothing changes. */
    pruneJiraTokens(drop: string[], globalOrigin: string) {
      const d = get();
      const t = d.jiraTokens ?? {};
      const kept = Object.keys(t).filter((o) => !drop.includes(o));
      const want = Object.hasOwn(t, globalOrigin) && !drop.includes(globalOrigin) ? t[globalOrigin] : undefined;
      if (kept.length === Object.keys(t).length && d.jiraToken === want && d.jiraOrigin === (want === undefined ? undefined : globalOrigin)) return;
      // Filtered on the freshly loaded data: a token another daemon wrote since `get()` stays unless it is dropped.
      store.change((x) => {
        setTokens(x, Object.fromEntries(Object.entries(x.jiraTokens ?? {}).filter(([o]) => !drop.includes(o))));
        mirror(x, globalOrigin);
      });
    },
  };
}
export type Secrets = ReturnType<typeof createSecrets>;
