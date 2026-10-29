// Write-only secrets (docs/spec.md "Settings", GH-447): secrets.json in the config dir (mode 0600), same JSON-file helper as settings.json.
// A secret is never sent in a reply, a broadcast or a log line; clients only learn whether one is set.
// The Jira token is stored with the origin it was saved for and only returned for that origin (GH-487).
import { createJsonFile } from "./json-file.ts";

type Stored = { jiraToken?: string; jiraOrigin?: string; jiraTokenReset?: true };
const parse = (raw: unknown): Stored => {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof r.jiraToken !== "string" || !r.jiraToken) return r.jiraTokenReset === true ? { jiraTokenReset: true } : {};
  // GH-487: a token without its origin (saved before) counts as not set; the flag tells Settings why.
  return typeof r.jiraOrigin === "string" ? { jiraToken: r.jiraToken, jiraOrigin: r.jiraOrigin } : { jiraTokenReset: true };
};
/** A Jira API token or personal access token: printable, no spaces, at most 2000 characters. */
export const tokenProblem = (t: unknown): string | undefined =>
  typeof t !== "string" || !t || t.length > 2000 || !/^[\x21-\x7e]+$/.test(t) ? "The token must be 1 to 2000 printable characters without spaces" : undefined;

/** Without `file` the secrets live in memory only (tests). */
export function createSecrets({ file }: { file?: string } = {}) {
  const store = createJsonFile<Stored>(file, parse, "secrets");
  return {
    /** The token, only for the origin it was saved for. */
    jiraToken: (origin: string): string | undefined => {
      const d = store.get();
      return d.jiraOrigin === origin ? d.jiraToken : undefined;
    },
    /** The origin of the saved token ("" = saved without URL); undefined without a token. */
    jiraTokenOrigin: (): string | undefined => {
      const d = store.get();
      return d.jiraToken ? d.jiraOrigin : undefined;
    },
    /** An old-format token was dropped and no new one was saved since. */
    jiraTokenReset: (): boolean => !!store.get().jiraTokenReset,
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
