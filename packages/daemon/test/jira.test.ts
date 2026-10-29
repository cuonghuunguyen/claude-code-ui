// Ticket tab, daemon side (GH-447): Jira auth by URL, my open tickets, key / text / URL search, errors.
import { afterEach, describe, expect, it } from "vitest";
import { createJira, JiraError } from "../src/jira.ts";
import { createSecrets } from "../src/secrets.ts";
import { fakeJira, type FakeJira, type FakeIssue } from "./fake-jira.ts";

const ISSUES: FakeIssue[] = [
  { key: "PRJ-1", type: "Bug", summary: "Login fails on Safari", status: "In Progress", mine: true },
  { key: "PRJ-2", type: "Story", summary: "Dark mode", status: "To Do", mine: true },
  { key: "PRJ-3", type: "Task", summary: "Old login cleanup", status: "Done", mine: true, done: true },
  { key: "OTH-9", type: "Task", summary: "Login audit", status: "To Do" },
];
const TOKEN = "s3cr3t-token-value";
let fake: FakeJira | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
/** fetch that sends `https://acme.atlassian.net/...` to the fake server (Cloud by its host name). */
const viaFake = (f: FakeJira): typeof fetch => (input, init) => fetch(String(input).replace("https://acme.atlassian.net", f.url), init);
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof JiraError ? e.code : `other: ${(e as Error).message}`));

describe("createJira", () => {
  it("Data Center: Bearer personal access token, /rest/api/2; Test connection gives the display name", async () => {
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, user: "Dana Center", issues: ISSUES });
    const j = createJira({ config: () => ({ url: `${fake!.url}/`, email: "" }), token: () => TOKEN });
    expect(await j.test()).toEqual({ user: "Dana Center" });
    expect(fake.requests.at(-1)!.path).toBe("/rest/api/2/myself");
  });

  it("Cloud (*.atlassian.net): Basic email:token, /rest/api/3, my open tickets newest first", async () => {
    fake = await fakeJira({ auth: `Basic ${Buffer.from(`ann@example.com:${TOKEN}`).toString("base64")}`, user: "Ann Cloud", issues: ISSUES });
    const j = createJira({ config: () => ({ url: "https://acme.atlassian.net", email: "ann@example.com" }), token: () => TOKEN, fetch: viaFake(fake) });
    expect(await j.test()).toEqual({ user: "Ann Cloud" });
    const mine = await j.search();
    expect(mine.map((t) => t.key)).toEqual(["PRJ-1", "PRJ-2"]);
    expect(mine[0]).toEqual({ key: "PRJ-1", type: "Bug", summary: "Login fails on Safari", status: "In Progress" });
    const req = new URL(fake.requests.at(-1)!.path, "http://x");
    expect(req.pathname).toBe("/rest/api/3/search/jql");
    expect(req.searchParams.get("jql")).toBe("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC");
    expect(req.searchParams.get("maxResults")).toBe("20");
  });

  it("search by key, by pasted URL and by summary text", async () => {
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, issues: ISSUES });
    const j = createJira({ config: () => ({ url: fake!.url, email: "" }), token: () => TOKEN });
    expect((await j.search("prj-3")).map((t) => t.key)).toEqual(["PRJ-3"]);
    expect((await j.search(`${fake.url}/browse/OTH-9`)).map((t) => t.key)).toEqual(["OTH-9"]);
    expect(await j.search("NOPE-404")).toEqual([]);
    expect((await j.search("login")).map((t) => t.key).sort()).toEqual(["OTH-9", "PRJ-1", "PRJ-3"]);
    // Quotes and JQL text operators in the typed text do not break the query.
    expect(await j.search('dark "mode" OR (x)')).toEqual([]);
    expect((await j.search("dark")).map((t) => t.key)).toEqual(["PRJ-2"]);
  });

  it("search: key-shaped text with no such ticket runs the summary search", async () => {
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, issues: [{ key: "PRJ-7", type: "Bug", summary: "fix 123 crash on save", status: "To Do" }] });
    const j = createJira({ config: () => ({ url: fake!.url, email: "" }), token: () => TOKEN });
    expect((await j.search("fix-123")).map((t) => t.key)).toEqual(["PRJ-7"]);
    expect(fake.requests.some((r) => r.path.includes("search") && new URL(r.path, "http://x").searchParams.get("jql")?.includes("summary ~"))).toBe(true);
    // A link to a missing ticket: nothing.
    const before = fake.requests.length;
    expect(await j.search(`${fake.url}/browse/FIX-123`)).toEqual([]);
    expect(fake.requests.slice(before).some((r) => r.path.includes("search"))).toBe(false);
  });

  it("Ticket filter (JQL): lists its tickets with its order; text searches inside it; a key ignores it", async () => {
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, issues: ISSUES });
    let jql = "project = OTH order by created ASC";
    const j = createJira({ config: () => ({ url: fake!.url, email: "", jql }), token: () => TOKEN });
    const last = () => new URL(fake!.requests.at(-1)!.path, "http://x").searchParams.get("jql");
    expect((await j.search()).map((t) => t.key)).toEqual(["OTH-9"]);
    expect(last()).toBe("project = OTH order by created ASC");
    expect((await j.search("login")).map((t) => t.key)).toEqual(["OTH-9"]);
    expect(last()).toBe('(project = OTH) AND summary ~ "login*" ORDER BY created ASC');
    expect((await j.search("PRJ-1")).map((t) => t.key)).toEqual(["PRJ-1"]);
    // ORDER BY inside a quoted value is not the order clause; no order clause: newest first.
    jql = 'project = OTH AND summary !~ "sort order by x"';
    await j.search("audit");
    expect(last()).toBe('(project = OTH AND summary !~ "sort order by x") AND summary ~ "audit*" ORDER BY updated DESC');
    // Blank filter: the default (my open tickets; text searches every ticket).
    jql = "  ";
    expect((await j.search()).map((t) => t.key)).toEqual(["PRJ-1", "PRJ-2"]);
    expect((await j.search("login")).map((t) => t.key).sort()).toEqual(["OTH-9", "PRJ-1", "PRJ-3"]);
  });

  it("errors: not configured, wrong token (401/403), unreachable, other HTTP failures; none carries the token", async () => {
    expect(await code(createJira({ config: () => ({ url: "", email: "" }), token: () => TOKEN }).search())).toBe("jira_not_configured");
    expect(await code(createJira({ config: () => ({ url: "https://jira.example.com", email: "" }), token: () => undefined }).search())).toBe("jira_not_configured");
    expect(await code(createJira({ config: () => ({ url: "https://acme.atlassian.net", email: "" }), token: () => TOKEN }).search())).toBe("jira_not_configured");
    fake = await fakeJira({ auth: "Bearer right", issues: ISSUES });
    const wrong = createJira({ config: () => ({ url: fake!.url, email: "" }), token: () => TOKEN });
    const e = (await wrong.test().catch((x) => x)) as JiraError;
    expect(e).toBeInstanceOf(JiraError);
    expect(e.code).toBe("jira_auth");
    expect(e.message).not.toContain(TOKEN);
    await fake.close();
    const down = createJira({ config: () => ({ url: fake!.url, email: "" }), token: () => TOKEN, timeoutMs: 2000 });
    expect(await code(down.test())).toBe("jira_unreachable");
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, issues: ISSUES, status: 403 });
    expect(await code(createJira({ config: () => ({ url: fake!.url, email: "" }), token: () => TOKEN }).search())).toBe("jira_auth");
    await fake.close();
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, issues: ISSUES, status: 500 });
    const failed = (await createJira({ config: () => ({ url: fake!.url, email: "" }), token: () => TOKEN }).search().catch((x) => x)) as JiraError;
    expect(failed.code).toBe("jira_failed");
    expect(failed.message).toContain("forced 500");
  });
  it("never sends the token to another origin than the one it was saved for (GH-487)", async () => {
    fake = await fakeJira({ auth: `Bearer ${TOKEN}`, issues: ISSUES });
    const s = createSecrets();
    s.setJiraToken(TOKEN, "https://jira.example.com");
    const j = createJira({ config: () => ({ url: fake!.url, email: "" }), token: (o) => s.jiraToken(o) });
    expect(await code(j.test())).toBe("jira_not_configured");
    expect(await code(j.search())).toBe("jira_not_configured");
    expect(fake.requests).toEqual([]);
  });
});
