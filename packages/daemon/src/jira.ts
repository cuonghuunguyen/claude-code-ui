// Jira client of the Create worktree modal's Ticket tab (docs/spec.md "Worktrees", GH-447). One app-wide connection: base URL, email
// (Cloud only) and branch template in settings.json, the token in secrets.json. Auth by URL: `*.atlassian.net` = Cloud (email + API
// token, Basic, /rest/api/3), else Data Center / Server (personal access token, Bearer, /rest/api/2). The token never leaves this module
// except in the Authorization header to the configured base URL; no error message carries it.
import { jiraIsCloud, jiraKeyOf, MY_OPEN_JQL, type JiraTicket } from "@claude-ui/protocol";

export type JiraErrorCode = "jira_not_configured" | "jira_auth" | "jira_unreachable" | "jira_failed";
export class JiraError extends Error {
  constructor(readonly code: JiraErrorCode, message: string) {
    super(message);
  }
}

const ROWS = 20;
const FIELDS = "summary,issuetype,status";
/** Characters of Jira's text search syntax (Lucene) and JQL quoting; typed text keeps only words. */
const SPECIAL = /[+\-&|!(){}[\]^~*?\\:"'/]/g;

/**
 * A JQL query split into its condition and its ORDER BY clause (the last `order by` outside quoted values), so typed text
 * can be ANDed to the condition: `(cond) AND summary ~ "…" ORDER BY …`.
 */
export function splitJql(jql: string): { where: string; order?: string } {
  const blanked = jql.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
  const all = [...blanked.matchAll(/\border\s+by\b/gi)];
  const at = all.at(-1)?.index;
  if (at === undefined) return { where: jql.trim() };
  return { where: jql.slice(0, at).trim(), order: jql.slice(at).replace(/^order\s+by\s*/i, "").trim() || undefined };
}

export type JiraDeps = {
  /** `jql`: the Ticket filter of Settings › Jira; blank = MY_OPEN_JQL. */
  config: () => { url: string; email: string; jql?: string };
  token: () => string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Raw = { key?: unknown; fields?: { summary?: unknown; issuetype?: { name?: unknown }; status?: { name?: unknown } } };
const str = (v: unknown) => (typeof v === "string" ? v : "");
const ticketOf = (r: Raw): JiraTicket => ({ key: str(r.key), type: str(r.fields?.issuetype?.name), summary: str(r.fields?.summary), status: str(r.fields?.status?.name) });

export function createJira(d: JiraDeps) {
  const doFetch = d.fetch ?? fetch;
  /** GET `<base>/rest/api/<2|3>/<path>`; 404 is null. */
  async function get(path: string): Promise<unknown | null> {
    const { url, email } = d.config();
    const token = d.token();
    if (!url) throw new JiraError("jira_not_configured", "Jira is not set up: add its URL and token in Settings › Jira");
    if (!token) throw new JiraError("jira_not_configured", "No Jira token: set one in Settings › Jira");
    const cloud = jiraIsCloud(url);
    if (cloud && !email) throw new JiraError("jira_not_configured", "Jira Cloud needs your account email: set it in Settings › Jira");
    const base = url.replace(/\/+$/, "");
    const auth = cloud ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}`;
    let res: Response;
    try {
      // No redirect: the Authorization header must reach only the configured address.
      res = await doFetch(`${base}/rest/api/${cloud ? 3 : 2}/${path}`, { headers: { Authorization: auth, Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(d.timeoutMs ?? 15_000) });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new JiraError("jira_unreachable", `Jira is unreachable: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new JiraError("jira_auth", `Jira refused the ${cloud ? "email and API token" : "personal access token"} (HTTP ${res.status})`);
    if (res.status === 404) return null;
    if (res.status >= 300 && res.status < 400) throw new JiraError("jira_failed", `Jira redirected to ${res.headers.get("location") ?? "another address"}: set the base URL to the address Jira runs at`);
    const body = await res.json().catch(() => undefined);
    if (!res.ok) {
      const msg = (body as { errorMessages?: unknown[] } | undefined)?.errorMessages?.find((x) => typeof x === "string") as string | undefined;
      throw new JiraError("jira_failed", `Jira answered HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    return body;
  }
  const search = async (jql: string): Promise<JiraTicket[]> => {
    const q = new URLSearchParams({ jql, fields: FIELDS, maxResults: String(ROWS) });
    const cloud = jiraIsCloud(d.config().url);
    const r = (await get(`${cloud ? "search/jql" : "search"}?${q}`)) as { issues?: Raw[] } | null;
    return (r?.issues ?? []).map(ticketOf).filter((t) => t.key);
  };
  return {
    /** Test connection: the Jira user's display name. */
    async test(): Promise<{ user: string }> {
      const me = (await get("myself")) as { displayName?: unknown } | null;
      if (!me) throw new JiraError("jira_failed", "Jira has no /myself here: check the base URL");
      return { user: str(me.displayName) || "(no name)" };
    },
    /**
     * No text: the Ticket filter's tickets (default: my open ones); a key or ticket URL: that ticket, filter or not; other text:
     * tickets whose summary has its words, inside the Ticket filter when one is set.
     */
    async search(text = ""): Promise<JiraTicket[]> {
      const t = text.trim();
      const filter = d.config().jql?.trim() || "";
      if (!t) return search(filter || MY_OPEN_JQL);
      const key = jiraKeyOf(t);
      if (key) {
        const r = (await get(`issue/${encodeURIComponent(key)}?fields=${FIELDS}`)) as Raw | null;
        if (r) return [ticketOf(r)];
        if (/^https?:\/\//i.test(t)) return []; // a link to a missing ticket: nothing to search
      }
      const words = t.replace(SPECIAL, " ").split(/\s+/).filter((w) => w && !/^(and|or|not)$/i.test(w));
      if (!words.length) return search(filter || MY_OPEN_JQL);
      const summary = `summary ~ "${words.join(" ")}*"`;
      if (!filter) return search(`${summary} ORDER BY updated DESC`);
      const { where, order } = splitJql(filter);
      return search(`${where ? `(${where}) AND ` : ""}${summary} ORDER BY ${order ?? "updated DESC"}`);
    },
  };
}
export type Jira = ReturnType<typeof createJira>;
