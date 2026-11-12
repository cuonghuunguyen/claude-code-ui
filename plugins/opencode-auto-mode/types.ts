// Local, minimal stand-ins for the slice of the OpenCode 1.19.5 V1 plugin/SDK API this
// plugin touches. Kept local (never imported from @opencode-ai/plugin or @opencode-ai/sdk)
// so auto-mode.ts loads with zero install: only relative imports and node builtins.

export type MessagePart =
  | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
  | { type: "tool"; callID: string; tool: string; state?: { status: string; input?: Record<string, unknown> } }
  | { type: string; [key: string]: unknown };

export type MessageInfo =
  | { role: "user"; agent?: string; model?: { providerID: string; modelID: string } }
  | { role: "assistant"; providerID?: string; modelID?: string };

export interface TranscriptMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

/** The `permission.asked` event's `properties` (see permission/index.ts `Event.Asked`). */
export interface PermissionAskedProperties {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

export interface OpencodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

interface ApiResult<T> {
  data?: T;
  error?: unknown;
  response?: { status: number };
}

/** The hey-api `Client`'s raw, un-generated request surface (`client._client`). */
export interface RawClient {
  get(options: { url: string; query?: Record<string, unknown>; signal?: AbortSignal }): Promise<ApiResult<unknown>>;
  post(options: {
    url: string;
    path?: Record<string, unknown>;
    body?: unknown;
    query?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ApiResult<unknown>>;
}

export interface OpencodeClient {
  /** Protected on the real SDK class; present at runtime. */
  _client?: RawClient;
  session: {
    create(options: {
      body?: { title?: string };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<{ id: string }>>;
    prompt(options: {
      path: { id: string };
      body: {
        agent?: string;
        model?: { providerID: string; modelID: string };
        parts: Array<{ type: "text"; text: string }>;
      };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<{ info: unknown; parts: MessagePart[] }>>;
    delete(options: { path: { id: string }; query?: { directory?: string } }): Promise<ApiResult<unknown>>;
    abort(options: { path: { id: string }; query?: { directory?: string } }): Promise<ApiResult<unknown>>;
    messages(options: {
      path: { id: string };
      query?: { directory?: string };
      signal?: AbortSignal;
    }): Promise<ApiResult<TranscriptMessage[]>>;
  };
  /** V1 fallback route: `POST /session/{id}/permissions/{permissionID}`. */
  postSessionIdPermissionsPermissionId(options: {
    path: { id: string; permissionID: string };
    body?: { response: "once" | "always" | "reject" };
  }): Promise<ApiResult<unknown>>;
  app: {
    log(options: {
      body: { service: string; level: "debug" | "info" | "warn" | "error"; message: string; extra?: Record<string, unknown> };
    }): Promise<ApiResult<unknown>>;
  };
  tui: {
    showToast(options: {
      body: { title?: string; message: string; variant: "info" | "success" | "warning" | "error" };
    }): Promise<ApiResult<unknown>>;
  };
}

export interface PluginInput {
  client: OpencodeClient;
  project?: unknown;
  directory: string;
  worktree: string;
  serverUrl: URL;
  $?: unknown;
}

export type PluginOptions = Record<string, unknown>;

/** The slice of opencode.json `Config` the `config` hook may mutate. */
export interface ConfigHookInput {
  agent?: Record<string, unknown>;
  command?: Record<string, { template: string; description?: string }>;
  [key: string]: unknown;
}

export interface ChatParamsInput {
  sessionID: string;
  agent: string;
  model: unknown;
  provider: unknown;
  message: unknown;
}

export interface ChatParamsOutput {
  temperature: number;
  topP: number;
  topK: number;
  maxOutputTokens: number | undefined;
  options: Record<string, unknown>;
}

export interface ToolExecuteBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

export interface ToolExecuteBeforeOutput {
  args: unknown;
}

export interface ToolExecuteAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
}

export interface Hooks {
  /** Plugin tools: `{ description, args, execute }` (see tools.ts). */
  tool?: Record<string, import("./tools.ts").PluginTool>;
  event?: (input: { event: OpencodeEvent }) => Promise<void>;
  config?: (input: ConfigHookInput) => Promise<void>;
  "chat.params"?: (input: ChatParamsInput, output: ChatParamsOutput) => Promise<void>;
  "tool.execute.before"?: (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>;
  "tool.execute.after"?: (input: ToolExecuteAfterInput, output: unknown) => Promise<void>;
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;

export interface AutoModeOptions {
  enabled?: boolean;
  /** "provider/model"; default: the model of the asking session's latest message. */
  model?: string;
  timeoutMs?: number;
  maxConsecutiveBlocks?: number;
  maxTotalBlocks?: number;
  allow?: string[];
  softDeny?: string[];
  environment?: string[];
  replaceDefaults?: boolean;
  /** What the classifier does when unsure: "ask" defers to the human (default), "block" blocks. */
  unsure?: "ask" | "block";
  maxOutputTokens?: number;
  transcriptChars?: number;
  /** Permissions never auto-decided; left for the human. */
  skipPermissions?: string[];
  /** When set, only these permissions are auto-decided; all others are left for the human. */
  onlyPermissions?: string[];
  /** Write the local decision log (default true). */
  log?: boolean;
  /** Data dir for the log (default OpenCode's own data dir); the log is `<dir>/auto-mode/decisions.jsonl`. */
  logDir?: string;
  /** Rotate the log past this size (default 20 MB). */
  logMaxBytes?: number;
}

export interface ResolvedAutoModeOptions {
  enabled: boolean;
  model?: string;
  timeoutMs: number;
  maxConsecutiveBlocks: number;
  maxTotalBlocks: number;
  allow: string[];
  softDeny: string[];
  environment: string[];
  replaceDefaults: boolean;
  unsure: "ask" | "block";
  maxOutputTokens: number;
  transcriptChars: number;
  skipPermissions: string[];
  onlyPermissions?: string[];
  log: boolean;
  logDir?: string;
  logMaxBytes: number;
}

export const DEFAULT_OPTIONS: ResolvedAutoModeOptions = {
  enabled: true,
  timeoutMs: 60_000,
  maxConsecutiveBlocks: 3,
  maxTotalBlocks: 20,
  allow: [],
  softDeny: [],
  environment: [],
  replaceDefaults: false,
  unsure: "ask",
  maxOutputTokens: 1024,
  transcriptChars: 60_000,
  skipPermissions: [],
  log: true,
  logMaxBytes: 20 * 1024 * 1024,
};

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

function positive(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Malformed values fall back to the defaults (or, for the permission filters, are ignored). */
export function resolveOptions(options: PluginOptions | undefined): ResolvedAutoModeOptions {
  const o = (options ?? {}) as Record<string, unknown>;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_OPTIONS.enabled,
    model: typeof o.model === "string" && o.model.includes("/") ? o.model : undefined,
    timeoutMs: positive(o.timeoutMs, DEFAULT_OPTIONS.timeoutMs),
    maxConsecutiveBlocks: positive(o.maxConsecutiveBlocks, DEFAULT_OPTIONS.maxConsecutiveBlocks),
    maxTotalBlocks: positive(o.maxTotalBlocks, DEFAULT_OPTIONS.maxTotalBlocks),
    allow: strings(o.allow) ?? DEFAULT_OPTIONS.allow,
    softDeny: strings(o.softDeny) ?? DEFAULT_OPTIONS.softDeny,
    environment: strings(o.environment) ?? DEFAULT_OPTIONS.environment,
    replaceDefaults: o.replaceDefaults === true,
    unsure: o.unsure === "block" ? "block" : "ask",
    maxOutputTokens: positive(o.maxOutputTokens, DEFAULT_OPTIONS.maxOutputTokens),
    transcriptChars: positive(o.transcriptChars, DEFAULT_OPTIONS.transcriptChars),
    skipPermissions: strings(o.skipPermissions) ?? DEFAULT_OPTIONS.skipPermissions,
    onlyPermissions: strings(o.onlyPermissions),
    log: typeof o.log === "boolean" ? o.log : DEFAULT_OPTIONS.log,
    logDir: typeof o.logDir === "string" && o.logDir ? o.logDir : undefined,
    logMaxBytes: positive(o.logMaxBytes, DEFAULT_OPTIONS.logMaxBytes),
  };
}
