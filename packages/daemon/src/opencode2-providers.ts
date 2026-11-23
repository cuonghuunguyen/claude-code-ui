// Provider login on OpenCode 2 (docs/spec.md "OpenCode engine" › Provider login, GH-879): the requests of the OpenCode 1 login over OpenCode 2's integrations and credentials.
// The daemon relays, OpenCode stores the credentials; keys, form answers and codes are never logged.
import type { ClientMessage, OpenCodeAuthMethod, OpenCodeAuthPrompt, OpenCodeProvider } from "@claude-ui/protocol";
import type { EngineRequest } from "./engine-catalogue.ts";
import { checkLogin, sortProviders } from "./opencode-providers.ts";
import { OpenCodeError, type OpenCodeServer } from "./opencode-server.ts";

type Field = { key: string; type: string; title?: string; placeholder?: string; hidden?: boolean; options?: { value: string; label: string; description?: string }[]; when?: { key: string; op: "eq" | "neq"; value: unknown }[] };
type Method = { type: "key"; label?: string; form?: Field[] } | { type: "oauth"; id: string; label: string; form?: Field[] } | { type: "command" | "external"; id: string; label: string } | { type: "env"; names: string[] };
type Connection = { type: "credential"; id: string; method: "key" | "oauth" | "external" } | { type: "env"; name: string };
export type Integration = { id: string; name: string; methods: Method[]; connections: Connection[] };
/** How a listed method is run in OpenCode 2. */
type Ref = { kind: "key" } | { kind: "oauth"; id: string };

/** The prompts of a method's form; undefined when a shown field has no prompt shape (a text or select field with at most one `when` condition). Hidden fields keep OpenCode's default. */
export function promptsOf(form: Field[] = []): OpenCodeAuthPrompt[] | undefined {
  const out: OpenCodeAuthPrompt[] = [];
  for (const f of form) {
    if (f.hidden) continue;
    if (f.type !== "string" || (f.when?.length ?? 0) > 1) return undefined;
    const w = f.when?.[0];
    const when = w && { key: w.key, op: w.op, value: String(w.value) };
    const message = f.title ?? f.key;
    out.push(
      f.options?.length
        ? { type: "select", key: f.key, message, options: f.options.map((x) => ({ label: x.label, value: x.value, ...(x.description && { hint: x.description }) })), ...(when && { when }) }
        : { type: "text", key: f.key, message, ...(f.placeholder && { placeholder: f.placeholder }), ...(when && { when }) },
    );
  }
  return out;
}

/** The methods claude-ui runs (API key, OAuth with a form it can show), in OpenCode's order, with how each is run. */
export function methodsOf(i: Integration): { method: OpenCodeAuthMethod; ref: Ref }[] {
  return i.methods.flatMap((m) => {
    if (m.type !== "key" && m.type !== "oauth") return [];
    const prompts = promptsOf(m.form);
    if (!prompts) return [];
    const method: OpenCodeAuthMethod = { type: m.type === "key" ? "api" : "oauth", label: m.label ?? "API key", ...(prompts.length && { prompts }) };
    return [{ method, ref: m.type === "key" ? { kind: "key" as const } : { kind: "oauth" as const, id: m.id } }];
  });
}

/** An integration as the OpenCode 1 provider row: `source` `api` (key credential), `custom` (OAuth, external), `env`. No method claude-ui runs: `unavailable` says where to connect it. */
export function providerOf(i: Integration): OpenCodeProvider {
  const methods = methodsOf(i).map((x) => x.method);
  const cred = i.connections.find((c) => c.type === "credential");
  const source = cred ? (cred.method === "key" ? "api" : "custom") : i.connections.length ? "env" : undefined;
  const out: OpenCodeProvider = { id: i.id, name: i.name, connected: i.connections.length > 0, ...(source && { source }), methods };
  if (methods.length) return out;
  const env = i.methods.flatMap((m) => (m.type === "env" ? m.names : []));
  const app = i.methods.some((m) => m.type !== "env");
  const ways = [app && `connect ${i.name} in OpenCode's own app`, env.length && `set ${env.join(" or ")} in the environment OpenCode starts in`].filter((x): x is string => !!x);
  const text = ways.join(", or ");
  return { ...out, unavailable: text ? `${text[0]!.toUpperCase()}${text.slice(1)}.` : `Connect ${i.name} in OpenCode's own app.` };
}

/** A folder OpenCode 2 has not loaded yet lists no integration for a moment: read again for this long. */
const COLD_MS = 5000;
const POLL_MS = 1000;
const OAUTH_MS = 15 * 60_000;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
});
/** OpenCode's own text of a failed request (`{message}` of its error body), else the error's. */
const textOf = (err: unknown) => {
  const e = err as { body?: { message?: unknown }; cause?: { body?: { message?: unknown } }; message?: string };
  const m = e.body?.message ?? e.cause?.body?.message;
  return typeof m === "string" && m ? m : (e.message ?? String(err));
};
/** Form values for OpenCode: an empty one is left out (OpenCode then uses the field's default). */
const answerOf = (inputs?: Record<string, string>) => {
  const a = Object.fromEntries(Object.entries(inputs ?? {}).filter(([, v]) => v !== ""));
  return Object.keys(a).length ? { answer: a } : {};
};

export type OpenCode2LoginDeps = {
  server: OpenCodeServer;
  /** The folder whose integrations are listed (OpenCode 2 lists them per location; credentials are global). */
  folder(): string;
  /** A login or logout changed the providers: drop the model lists and tell the clients. */
  changed(): void;
};

/** The `opencode.providers|login|loginFinish|loginCancel|logout` requests on OpenCode 2. `busy`: an OAuth login waits (a server restart would lose it). */
export function createOpenCode2Login(o: OpenCode2LoginDeps): { requests: Partial<Record<ClientMessage["type"], EngineRequest>>; busy(): boolean } {
  const { server } = o;
  /** The OAuth attempt of each provider (one at a time), started by `opencode.login`. */
  const attempts = new Map<string, { integrationID: string; attemptID: string; directory: string; mode: "auto" | "code" }>();
  /** The `opencode.loginFinish` wait of each provider; a cancel or a new login aborts it. */
  const waits = new Map<string, AbortController>();

  async function integrations(directory: string): Promise<Integration[]> {
    const client = await server.client();
    const start = Date.now();
    for (;;) {
      const r = await client.integration.list({ location: { directory } });
      const list = r.data as unknown as Integration[];
      if (list.length || Date.now() - start >= COLD_MS) return list;
      await sleep(250);
    }
  }
  const providers = async (list: Integration[]) => sortProviders(list.map(providerOf));
  /** Ends the provider's OAuth attempt in OpenCode (v2 really cancels it) and its wait. */
  const cancel = async (provider: string) => {
    waits.get(provider)?.abort();
    waits.delete(provider);
    const a = attempts.get(provider);
    attempts.delete(provider);
    if (a) await (await server.client()).integration.oauth.cancel({ integrationID: a.integrationID, attemptID: a.attemptID, location: { directory: a.directory } }).catch(() => {});
  };

  const login: EngineRequest = async (request, reply, fail) => {
    const msg = request as Extract<ClientMessage, { type: "opencode.providers" | "opencode.login" | "opencode.loginFinish" | "opencode.loginCancel" | "opencode.logout" }>;
    const provider = "provider" in msg && typeof msg.provider === "string" ? msg.provider : "";
    const field = (m: string) => fail("invalid_input", m);
    let wait: AbortController | undefined;
    const cleanWait = () => wait && waits.get(provider) === wait && waits.delete(provider);
    try {
      if (msg.type === "opencode.loginCancel") return (await cancel(provider), reply({}));
      // Registered before the list: a loginCancel in that window must reach this wait.
      wait = msg.type === "opencode.loginFinish" ? new AbortController() : undefined;
      if (wait) (waits.get(provider)?.abort(), waits.set(provider, wait));
      const directory = o.folder();
      const list = await integrations(directory).catch((err) => (cleanWait(), Promise.reject(err)));
      if (wait?.signal.aborted) return fail("cancelled", "Login cancelled");
      const shown = await providers(list);
      if (msg.type === "opencode.providers") return reply({ providers: shown });
      const integration = list.find((i) => i.id === provider);
      const client = await server.client();
      const location = { directory };
      const done = async () => (o.changed(), reply({ providers: await providers(await integrations(directory)) }));
      if (msg.type === "opencode.logout") {
        if (!integration) return field("provider: Unknown provider");
        const creds = integration.connections.flatMap((c) => (c.type === "credential" ? [c.id] : []));
        if (!creds.length) return field(`provider: ${integration.name} is connected through the environment: there is nothing to log out`);
        for (const id of creds) await client.credential.remove({ credentialID: id });
        return await done();
      }
      const api = msg.type === "opencode.login" && shown.find((p) => p.id === provider)?.methods[msg.method as number]?.type === "api";
      const c = checkLogin(msg, shown, api ? "api" : "oauth");
      if ("error" in c) return (cleanWait(), field(c.error));
      const ref = methodsOf(integration!)[msg.method as number]!.ref;
      if (msg.type === "opencode.login" && ref.kind === "key") {
        await client.integration.connect.key({ integrationID: provider, location, key: c.key!, ...answerOf(c.inputs) });
        return await done();
      }
      if (msg.type === "opencode.login" && ref.kind === "oauth") {
        await cancel(provider);
        const r = (await client.integration.oauth.connect({ integrationID: provider, location, methodID: ref.id, ...answerOf(c.inputs) })).data as { attemptID: string; url: string; instructions?: string; mode: "auto" | "code" };
        if (!r?.url) return fail("login_failed", "OpenCode gave no login page for this method.");
        attempts.set(provider, { integrationID: provider, attemptID: r.attemptID, directory, mode: r.mode });
        return reply({ url: r.url, mode: r.mode, instructions: r.instructions ?? "" });
      }
      // opencode.loginFinish
      const a = attempts.get(provider);
      if (!a) return (cleanWait(), fail("login_failed", "The login expired. Start it again."));
      const at = { integrationID: a.integrationID, attemptID: a.attemptID, location: { directory: a.directory } };
      const code = msg.type === "opencode.loginFinish" && typeof msg.code === "string" ? msg.code.trim() : "";
      if (a.mode === "code" || code) {
        cleanWait();
        if (!code) return field("code: Enter the code");
        try {
          await client.integration.oauth.complete({ ...at, code });
        } catch (err) {
          if (err instanceof OpenCodeError) throw err;
          return fail("login_failed", `code: ${textOf(err)}`);
        }
        attempts.delete(provider);
        return await done();
      }
      const ctl = wait!;
      try {
        for (const end = Date.now() + OAUTH_MS; ; ) {
          const s = (await client.integration.oauth.status(at, { signal: ctl.signal }).catch((err) => (ctl.signal.aborted ? undefined : Promise.reject(err))))?.data as { status: string; message?: string } | undefined;
          if (ctl.signal.aborted) return fail("cancelled", "Login cancelled");
          if (s?.status === "complete") break;
          if (s?.status === "failed") return (attempts.delete(provider), fail("login_failed", s.message || "Login was not completed. Try again."));
          if (s?.status !== "pending" || Date.now() >= end) return (attempts.delete(provider), fail("login_failed", "The login expired. Start it again."));
          await sleep(POLL_MS, ctl.signal);
          if (ctl.signal.aborted) return fail("cancelled", "Login cancelled");
        }
      } finally {
        if (waits.get(provider) === ctl) waits.delete(provider);
      }
      attempts.delete(provider);
      return await done();
    } catch (err) {
      cleanWait();
      if (err instanceof OpenCodeError) return fail(err.code, err.message);
      return fail("login_failed", textOf(err));
    }
  };
  const requests: Partial<Record<ClientMessage["type"], EngineRequest>> = {};
  for (const type of ["opencode.providers", "opencode.login", "opencode.loginFinish", "opencode.loginCancel", "opencode.logout"] as const) requests[type] = login;
  return { requests, busy: () => waits.size > 0 };
}
