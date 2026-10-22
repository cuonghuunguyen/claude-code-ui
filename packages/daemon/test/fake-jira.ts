// A local fake Jira (Cloud `/rest/api/3`, Data Center `/rest/api/2`) for the Ticket tab tests (GH-447).
import { createServer, type IncomingMessage, type Server } from "node:http";

export type FakeIssue = { key: string; type: string; summary: string; status: string; mine?: boolean; done?: boolean };
export type FakeJira = { url: string; server: Server; requests: { path: string; auth?: string }[]; close: () => Promise<void> };

const fields = (i: FakeIssue) => ({ key: i.key, fields: { summary: i.summary, issuetype: { name: i.type }, status: { name: i.status } } });

/**
 * `auth`: the exact Authorization header it accepts (else 401). `/myself` gives `user`; search understands the default
 * JQL (assignee = currentUser() AND statusCategory != Done), `summary ~ "…"` and nothing else; `/issue/<key>` finds one.
 */
export async function fakeJira(o: { auth: string; user?: string; issues: FakeIssue[]; status?: number }): Promise<FakeJira> {
  const requests: FakeJira["requests"] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (o.status) return json(o.status, { errorMessages: [`forced ${o.status}`] });
    if (req.headers.authorization !== o.auth) return json(401, { errorMessages: ["You are not authenticated"] });
    const m = /^\/rest\/api\/(2|3)\/(.*)$/.exec(url.pathname);
    if (!m) return json(404, { errorMessages: ["no such resource"] });
    const [, , rest] = m;
    if (rest === "myself") return json(200, { displayName: o.user ?? "Ann Example", emailAddress: "ann@example.com" });
    const issue = /^issue\/([^/]+)$/.exec(rest!);
    if (issue) {
      const i = o.issues.find((x) => x.key === decodeURIComponent(issue[1]!));
      return i ? json(200, fields(i)) : json(404, { errorMessages: ["Issue does not exist or you do not have permission to see it."] });
    }
    if ((m[1] === "3" && rest === "search/jql") || (m[1] === "2" && rest === "search")) {
      const jql = url.searchParams.get("jql") ?? "";
      const max = Number(url.searchParams.get("maxResults") ?? 50);
      let hits: FakeIssue[];
      const text = /summary ~ "((?:[^"\\]|\\.)*)"/.exec(jql)?.[1];
      if (text !== undefined) {
        const words = text.replace(/\*$/, "").toLowerCase().split(/\s+/).filter(Boolean);
        hits = o.issues.filter((i) => words.every((w) => i.summary.toLowerCase().includes(w)));
      } else if (jql.includes("assignee = currentUser()") && jql.includes("statusCategory != Done")) hits = o.issues.filter((i) => i.mine && !i.done);
      else return json(400, { errorMessages: [`unsupported jql ${jql}`] });
      return json(200, { issues: hits.slice(0, max).map(fields) });
    }
    return json(404, { errorMessages: ["no such resource"] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, server, requests, close: () => new Promise((r) => server.close(() => r())) };
}
