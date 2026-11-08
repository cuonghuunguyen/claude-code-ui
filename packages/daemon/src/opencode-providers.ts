// Provider login of the OpenCode engine (docs/spec.md "OpenCode engine" › Provider login): the daemon relays, OpenCode stores the credentials.
import type { OpenCodeAuthMethod, OpenCodeProvider } from "@claude-ui/protocol";
import { OpenCodeHttpError, type OpenCodeServer } from "./opencode-server.ts";

type RawProvider = { id: string; name?: string; source?: OpenCodeProvider["source"]; models?: Record<string, { cost?: { input?: number } }> };
const POPULAR = ["opencode", "opencode-go", "anthropic", "openai", "google", "github-copilot", "openrouter"];
const API: OpenCodeAuthMethod = { type: "api", label: "API key" };
export const MAX_KEY = 4096;

/** The merge of `GET /provider` and `GET /provider/auth`, slim (no models), connected first, popular next, then by name. */
export function mergeProviders(raw: { all: RawProvider[]; connected: string[] }, auth: Record<string, OpenCodeAuthMethod[]>): OpenCodeProvider[] {
  const rank = (p: OpenCodeProvider) => (POPULAR.includes(p.id) ? POPULAR.indexOf(p.id) : POPULAR.length);
  return raw.all
    .map((p): OpenCodeProvider => {
      // OpenCode web: `opencode` counts as connected only when a model costs money; its free models work without a login.
      const free = p.id === "opencode" && !Object.values(p.models ?? {}).some((m) => (m.cost?.input ?? 0) > 0);
      return { id: p.id, name: p.name ?? p.id, connected: raw.connected.includes(p.id) && !free, ...(p.source && { source: p.source }), methods: auth[p.id]?.length ? auth[p.id]! : [API] };
    })
    .sort((a, b) => Number(b.connected) - Number(a.connected) || rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The first `GET /provider` of a run fetches models.dev (21 s measured, 7 MB); later ones answer in well under a second. */
const LIST_TIMEOUT_MS = 60_000;

export async function listProviders(server: OpenCodeServer): Promise<OpenCodeProvider[]> {
  const [raw, auth] = await Promise.all([server.request<{ all: RawProvider[]; connected: string[] }>("/provider", { timeoutMs: LIST_TIMEOUT_MS }), server.request<Record<string, OpenCodeAuthMethod[]>>("/provider/auth", { timeoutMs: LIST_TIMEOUT_MS })]);
  return mergeProviders(raw, auth);
}

export type LoginInput = { provider?: unknown; method?: unknown; key?: unknown; inputs?: unknown };
export type Checked = { method: OpenCodeAuthMethod; key?: string; inputs?: Record<string, string> } | { error: string };

/** Trust boundary for login requests. Messages never contain the key. `field: message` names the field. */
export function checkLogin(msg: LoginInput, providers: OpenCodeProvider[], type: "api" | "oauth"): Checked {
  const p = providers.find((x) => x.id === msg.provider);
  if (!p) return { error: "provider: Unknown provider" };
  const method = typeof msg.method === "number" ? p.methods[msg.method] : undefined;
  if (!method || method.type !== type) return { error: "method: Unknown login method" };
  let inputs: Record<string, string> | undefined;
  if (msg.inputs !== undefined) {
    if (!msg.inputs || typeof msg.inputs !== "object" || Array.isArray(msg.inputs) || Object.values(msg.inputs).some((v) => typeof v !== "string")) return { error: "inputs: Expected text values" };
    inputs = msg.inputs as Record<string, string>;
  }
  if (type === "oauth") return msg.key === undefined ? { method, inputs } : { error: "method: Unknown login method" };
  const key = msg.key;
  if (typeof key !== "string" || !key.trim()) return { error: "key: Enter the API key" };
  if (/\s/.test(key)) return { error: "key: An API key has no spaces" };
  if (key.length > MAX_KEY) return { error: `key: An API key has at most ${MAX_KEY} characters` };
  return { method, key, inputs };
}

/** OpenCode 400 bodies mapped by `name`; the text reaches the user. */
export function loginError(err: unknown): string {
  if (!(err instanceof OpenCodeHttpError)) return (err as Error).message;
  const b = err.body as { name?: string; data?: { field?: string; message?: string } } | undefined;
  switch (b?.name) {
    case "ProviderAuthValidationFailed":
      return `${b.data?.field ?? "input"}: ${b.data?.message ?? "Invalid value"}`;
    case "ProviderAuthOauthCallbackFailed":
      return "Login was not completed. Try again.";
    case "ProviderAuthOauthCodeMissing":
      return "code: Enter the code";
    case "ProviderAuthOauthMissing":
      return "The login expired. Start it again.";
  }
  return `OpenCode answered ${err.status}: ${(b?.data?.message ?? "").slice(0, 300)}`;
}
