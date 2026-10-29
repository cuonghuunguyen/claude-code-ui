// The replies every scene shares (a scene's own `replies` win), built from the scene's data. Handed to the fake daemon (packages/web/src/fake-client.ts).
import type { GitDiffResult, ListResult, ModelsResult, SettingsResult } from "@claude-ui/protocol";
import type { FakeDaemon } from "../../../packages/web/src/fake-client.ts";
import { fileAfter, fileBefore, listDir, MODELS, MODES } from "./demo.ts";
import { subscribeReply, type Scene } from "./scene.ts";

type Req = { type: string; [k: string]: unknown };

const SETTINGS: SettingsResult = {
  settings: { orchestration: { enabled: false, workerCap: 4, workerCapTotal: 0, maxDepth: 2, maxChildren: 4, coordinatorPermissions: false, workerMode: "default" as never, workerNotifications: true }, usageLimit: { autoContinue: false }, notifications: { desktop: false }, performance: { monitor: false }, jira: { url: "", email: "", template: "{type}/{key}-{summary}", jql: "" }, git: { autoRepositoryDetection: true, repositoryScanMaxDepth: 1, repositoryScanIgnoredFolders: ["node_modules"], scanRepositories: [], ignoredRepositories: [], detectSubmodules: true, detectSubmodulesLimit: 10, ignoreSubmodules: false, openRepositoryInParentFolders: "always" } },
};

export function daemonFor(scene: Scene): FakeDaemon {
  const byId = new Map(scene.sessions.map((s) => [s.info.id, s]));
  const terminals = scene.terminals ?? {};
  const list: ListResult = {
    sessions: scene.sessions.map((s) => s.info),
    projects: scene.projects,
    recentProjects: [],
    permissionModes: [...MODES],
    ...(scene.worktrees && { worktrees: scene.worktrees }),
  };
  const defaults: FakeDaemon["replies"] = {
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
  return { replies: { ...defaults, ...scene.replies }, events: scene.events };
}
