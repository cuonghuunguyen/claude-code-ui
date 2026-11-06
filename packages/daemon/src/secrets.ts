// Write-only secrets (docs/spec.md "Settings", GH-447): secrets.json in the config dir (mode 0600), same JSON-file helper as settings.json.
// A secret is never sent in a reply, a broadcast or a log line; clients only learn whether one is set.
// The Jira token is stored with the origin it was saved for and only returned for that origin (GH-487).
import { randomUUID } from "node:crypto";
import { createJsonFile } from "./json-file.ts";
import { nameOk } from "./settings.ts";

// `legacy` lives in memory only: the file held a token without its origin (saved before GH-487).
/** A named Claude token (`claude setup-token`) the user pasted (GH-615); `token` leaves this file only as the env of a CLI process. */
type ClaudeAccount = { id: string; name: string; token: string };
export const CLAUDE_ACCOUNTS_MAX = 20;
type Stored = { jiraToken?: string; jiraOrigin?: string; jiraTokenReset?: true; legacy?: true; claudeAccounts?: ClaudeAccount[] };
const parse = (raw: unknown): Stored => {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const accounts = (Array.isArray(r.claudeAccounts) ? r.claudeAccounts : [])
    .filter((a): a is ClaudeAccount => !!a && typeof a.id === "string" && !!a.id && nameOk(a.name) && typeof a.token === "string" && !tokenProblem(a.token))
    .slice(0, CLAUDE_ACCOUNTS_MAX);
  const rest = accounts.length ? { claudeAccounts: accounts } : {};
  if (typeof r.jiraToken === "string" && r.jiraToken) return typeof r.jiraOrigin === "string" ? { jiraToken: r.jiraToken, jiraOrigin: r.jiraOrigin, ...rest } : { legacy: true, ...rest };
  return r.jiraTokenReset === true ? { jiraTokenReset: true, ...rest } : rest;
};
/** A Jira API token or personal access token: printable, no spaces, at most 2000 characters. */
export const tokenProblem = (t: unknown): string | undefined =>
  typeof t !== "string" || !t || t.length > 2000 || !/^[\x21-\x7e]+$/.test(t) ? "The token must be 1 to 2000 printable characters without spaces" : undefined;

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
    /** Only for the env of a CLI process. */
    claudeToken: (id: string): string | undefined => get().claudeAccounts?.find((a) => a.id === id)?.token,
    /** Returns the new id. Throws when the name or token is invalid or the list is full. */
    addClaudeAccount(name: string, token: string): string {
      if (!nameOk(name)) throw new Error("The account name must be 1 to 60 characters without control characters");
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
      const d = get();
      return d.jiraOrigin === origin ? d.jiraToken : undefined;
    },
    /** The origin of the saved token ("" = saved without URL); undefined without a token. */
    jiraTokenOrigin: (): string | undefined => {
      const d = get();
      return d.jiraToken ? d.jiraOrigin : undefined;
    },
    /** An old-format token was removed and no token was saved since (Settings says why). */
    jiraTokenReset: (): boolean => !!get().jiraTokenReset,
    /** Binds a token saved without URL to `origin`, in one write; no-op for a token with an origin or none. */
    bindJiraToken(origin: string) {
      const d = get();
      if (!d.jiraToken || d.jiraOrigin !== "") return;
      // Checked again on the freshly loaded data: another daemon may have written since `get()`.
      store.change((x) => void (x.jiraToken && x.jiraOrigin === "" && (x.jiraOrigin = origin)));
    },
    /** The Jira URL was emptied: the "cleared by an update" notice has done its job. */
    endJiraTokenReset() {
      if (get().jiraTokenReset) store.change((d) => void (d.jiraTokenReset && delete d.jiraTokenReset));
    },
    /** null clears. `origin` = the origin of jira.url ("" without URL). Throws when the token is invalid or the save fails. */
    setJiraToken(token: string | null, origin = "") {
      if (token !== null) {
        const p = tokenProblem(token);
        if (p) throw new Error(p);
      }
      store.change((d) => {
        delete d.jiraTokenReset;
        if (token === null) delete d.jiraToken, delete d.jiraOrigin;
        else (d.jiraToken = token), (d.jiraOrigin = origin);
      });
    },
  };
}
export type Secrets = ReturnType<typeof createSecrets>;
