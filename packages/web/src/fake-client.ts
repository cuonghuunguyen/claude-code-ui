// Stands in for src/client.ts in the docs scenes (vite.scenes.config.ts redirects every import of it here): the same API, answered by the
// current scene instead of a daemon. Types and helpers come from the real module; only `connect` is replaced.
import type { GitDiffResult, ListResult, ModelsResult, ServerMessage, SessionsSearchResult, SettingsResult } from "@claude-ui/protocol";
import { connect as realConnect } from "../src/client.ts";
import { fileAfter, fileBefore, listDir, MODELS, MODES } from "./demo.ts";
import { subscribeReply, type Scene } from "./scene.ts";
import { SCENES } from "./index.ts";

export * from "../src/client.ts";

type Opts = Parameters<typeof realConnect>[0];
type Client = ReturnType<typeof realConnect>;
type Req = { type: string; [k: string]: unknown };

export const sceneName = () => new URLSearchParams(location.search).get("scene") ?? "";

/** Resolves once the scene's events are emitted: scenes-main waits for it before it marks the page ready. */
let markEmitted!: () => void;
export const sceneEmitted = new Promise<void>((r) => (markEmitted = r));

const SETTINGS: SettingsResult = {
  settings: { orchestration: { enabled: false, workerCap: 4, coordinatorPermissions: false, workerMode: "default" as never, workerNotifications: true }, usageLimit: { autoContinue: false }, notifications: { desktop: false }, performance: { monitor: false } },
};

/** Replies every scene shares; a scene's own `replies` win. */
function defaults(scene: Scene): Record<string, unknown | ((req: Req) => unknown)> {
  const byId = new Map(scene.sessions.map((s) => [s.info.id, s]));
  const terminals = scene.terminals ?? {};
  const list: ListResult = {
    sessions: scene.sessions.map((s) => s.info),
    projects: scene.projects,
    recentProjects: [],
    permissionModes: [...MODES],
    ...(scene.worktrees && { worktrees: scene.worktrees }),
  };
  return {
    "session.list": list,
    "session.subscribe": (req: Req) => {
      const s = byId.get(String(req.sessionId));
      if (!s) throw Object.assign(new Error("unknown session"), { code: "unknown_session" });
      return subscribeReply(s);
    },
    "models.list": { models: MODELS } satisfies ModelsResult,
    "settings.get": SETTINGS,
    "session.defaultMode": { mode: "default" },
    "session.commands": { commands: [] },
    "git.status": { status: { branch: "feature/checkout", added: 12, removed: 3 } },
    "terminal.list": { terminals: Object.entries(terminals).map(([id, t]) => ({ id, title: t.title })) },
    "terminal.attach": (req: Req) => ({ buffer: terminals[String(req.terminalId)]?.output ?? "" }),
    "git.diff": { diff: { prefix: "", base: "9f2c1ab", files: [{ status: "M", path: "src/checkout/cart.ts", added: 9, removed: 2 }, { status: "A", path: "src/checkout/coupons.ts", added: 24, removed: 0, untracked: true }, { status: "M", path: "src/checkout/cart.test.ts", added: 6, removed: 0 }] } } satisfies GitDiffResult,
    "fs.list": (req: Req) => listDir(String(req.path)),
    "fs.read": (req: Req) => fileAfter(String(req.path)),
    "git.fileAt": (req: Req) => fileBefore(String(req.path)),
    "fs.watch": {},
    "fs.unwatch": {},
    "terminal.detach": {},
    "terminal.resize": {},
    "push.focus": {},
  };
}

export function connect(opts: Opts): Client {
  const scene = SCENES[sceneName()];
  if (!scene) throw new Error(`unknown scene "${sceneName()}"; known: ${Object.keys(SCENES).join(", ")}`);
  const replies = { ...defaults(scene), ...scene.replies };
  const warned = new Set<string>();
  const fs = new Set<(m: Extract<ServerMessage, { type: "fs.changed" }>) => void>();
  const terminal = new Set<(m: Extract<ServerMessage, { type: "terminal.output" | "terminal.exit" }>) => void>();

  const dispatch = (m: ServerMessage) => {
    if (m.type === "event") return opts.onEvent(m);
    if (m.type === "fs.changed") return fs.forEach((l) => l(m));
    if (m.type === "terminal.output" || m.type === "terminal.exit") return terminal.forEach((l) => l(m));
    if (m.type === "sessions.changed") return opts.onSessionsChanged?.(m);
    if (m.type === "plan_usage") return opts.onPlanUsage?.(m.usage);
    if (m.type === "settings_changed") return opts.onSettingsChanged?.(m);
    if (m.type === "config.changed") return opts.onConfigChanged?.(m);
    if (m.type === "update_available" || m.type === "update_state") return opts.onUpdate?.(m);
    if (m.type === "daemon_stale") return opts.onStale?.(m.note);
  };

  queueMicrotask(() => {
    opts.onStatus?.("connected");
    opts.onOpen?.();
    // After the app's startup requests, so a scene event lands on a subscribed view.
    setTimeout(() => (scene.events ?? []).forEach(dispatch), 150);
    setTimeout(markEmitted, 200);
  });

  return {
    async request<T>(msg: Req): Promise<T> {
      const r = replies[msg.type];
      if (r === undefined) {
        if (!warned.has(msg.type)) console.warn(`[scene] unhandled request "${msg.type}", replied {}`);
        warned.add(msg.type);
        return {} as T;
      }
      return (typeof r === "function" ? (r as (m: Req) => unknown)(msg) : r) as T;
    },
    async search(): Promise<SessionsSearchResult> {
      return { scannedFiles: 0, scannedBytes: 0, ms: 0 };
    },
    onFsChanged: (l) => (fs.add(l), () => void fs.delete(l)),
    onTerminal: (l) => (terminal.add(l), () => void terminal.delete(l)),
    close() {},
  } as Client;
}
