// The Hub's routing table (CONTEXT.md "Routing class"): the one place that says where each client message goes.
// A new ClientMessage type without a row here is a typecheck error (and fails side-routes.test.ts).
import type { ClientMessage } from "@claude-ui/protocol";

/** What the router does when the destination is a Side (the Hub's own daemon always runs the message as is). */
export type OnSide = "forward" | "unsupported" | "media" | "page" | "wslApp";

/**
 * `by` = how the destination is found; each class reads only its own field(s):
 * - `hub`: the Hub; never forwarded, `side`, `sessionId`, `cwd`, `path` and `terminalId` are ignored.
 * - `session`: the owner of `sessionId` (an unlisted ID is looked up on every Side; contested = `side_conflict`).
 * - `sessionOrPath`: `sessionId` when it is a string, else the folder of `cwd`/`path`.
 * - `path`: the Side that owns `cwd ?? path`, else the Hub.
 * - `terminal`: the Side that owns `terminalId`, else the Hub.
 * - `named`: only `side`; absent = the Hub.
 * - `request`: the Side that raised `requestId`, else the Hub.
 * - `fanOut`: the router splits the message over the Hub and every ready Side and merges the answers.
 * The forwardable classes (`session` … `named`) honour an explicit `side` first; `hub`, `request` and `fanOut` never do.
 */
export type Route = { readonly by: "hub" | "request" | "fanOut" } | { readonly by: "session" | "sessionOrPath" | "path" | "terminal" | "named"; readonly onSide?: OnSide };
export type RouteClass = Route["by"];

const HUB: Route = { by: "hub" };
const REQUEST: Route = { by: "request" };
const FAN_OUT: Route = { by: "fanOut" };
const SESSION: Route = { by: "session" };
/** `artifact.preview`: the side builds the preview, the hub issues its own URL and streams the bytes (`opts.page`). */
const SESSION_PAGE: Route = { by: "session", onSide: "page" };
const SESSION_OR_PATH: Route = { by: "sessionOrPath" };
const PATH: Route = { by: "path" };
/** `fs.htmlPreview`: as `artifact.preview`, the side builds the preview and the hub streams the bytes. */
const PATH_PAGE: Route = { by: "path", onSide: "page" };
/** `fs.media`: a file on a Side is proxied in pieces (`opts.media`). */
const PATH_MEDIA: Route = { by: "path", onSide: "media" };
/** `fs.openExternal`: only a WSL Side on this machine opens a file in an app; the custom editor command is the Hub's own. */
const PATH_WSL_APP: Route = { by: "path", onSide: "wslApp" };
const TERMINAL: Route = { by: "terminal" };
const NAMED: Route = { by: "named" };

export const ROUTES: { readonly [T in ClientMessage["type"]]: Route } = {
  "session.create": PATH,
  "opencode.status": HUB,
  "opencode.restart": HUB,
  "opencode.providers": HUB,
  "opencode.login": HUB,
  "opencode.loginFinish": HUB,
  "opencode.loginCancel": HUB,
  "opencode.logout": HUB,
  "session.defaultMode": PATH,
  "session.commands": PATH,
  "session.agents": SESSION_OR_PATH,
  "session.subscribe": SESSION,
  "session.unsubscribe": SESSION,
  "session.page": SESSION,
  "session.edits": SESSION,
  "session.artifacts": SESSION,
  "session.media": SESSION,
  "artifact.preview": SESSION_PAGE,
  "session.prompt": SESSION,
  "session.bash": SESSION,
  "session.setModel": SESSION,
  "session.setPermissionMode": SESSION,
  "session.setEffort": SESSION,
  "session.setAgent": SESSION,
  "fs.upload": SESSION_OR_PATH,
  "session.interrupt": SESSION,
  "session.cancelContinue": SESSION,
  "session.enqueue": SESSION,
  "session.dequeue": SESSION,
  "session.sendQueued": SESSION,
  "session.stopSubagent": SESSION,
  "session.backgroundShell": SESSION,
  "session.allowDenied": SESSION,
  "session.localSettingsFile": SESSION,
  "session.alwaysAllowDenied": SESSION,
  "session.shellOutput": SESSION,
  "session.stopShell": SESSION,
  "permission.respond": REQUEST,
  "question.respond": REQUEST,
  "models.list": PATH,
  "session.list": FAN_OUT,
  "session.ids": HUB,
  "project.open": PATH,
  "project.remove": PATH,
  // Named, not Hub: a Side's settings are readable with `side` (the sync result of the Hub's settings, sides.test.ts).
  "settings.get": NAMED,
  "settings.set": HUB,
  "settings.project": HUB,
  "back.set": SESSION,
  "back.done": SESSION,
  "back.brief": SESSION,
  "jira.token": HUB,
  "claude.account.add": HUB,
  "claude.account.remove": HUB,
  "claude.account.test": HUB,
  "jira.test": HUB,
  "jira.search": HUB,
  "perf.report": HUB,
  "perf.client": HUB,
  "perf.clear": HUB,
  "session.rename": SESSION,
  "session.archive": SESSION,
  "session.delete": SESSION,
  "worker.close": SESSION,
  "aside.open": SESSION,
  "session.quickCompact": SESSION,
  "aside.close": SESSION,
  "aside.keep": SESSION,
  "worker.remove": SESSION,
  "fs.list": PATH,
  "side.start": HUB,
  "side.updateRemote": HUB,
  "side.check": HUB,
  "ssh.add": HUB,
  "side.prefs": HUB,
  "session.rewindPreview": SESSION,
  "session.rewind": SESSION,
  "fs.search": PATH,
  "fs.grep": PATH,
  "fs.replace": PATH,
  "fs.replaceUndo": PATH,
  "sessions.search": PATH,
  "ping": HUB,
  "push.key": HUB,
  "push.subscribe": HUB,
  "push.focus": FAN_OUT,
  "fs.openExternal": PATH_WSL_APP,
  "fs.read": PATH,
  "fs.media": PATH_MEDIA,
  "fs.htmlPreview": PATH_PAGE,
  "media.read": PATH,
  // Hub to side only (the hub calls the side directly); a browser on the hub gets bad_request.
  "preview.read": HUB,
  "fs.write": PATH,
  "history.list": PATH,
  "history.read": PATH,
  "history.restore": PATH,
  "history.rename": PATH,
  "history.delete": PATH,
  "history.create": PATH,
  "fs.create": PATH,
  "fs.rename": PATH,
  "fs.walk": PATH,
  "fs.copy": NAMED,
  "fs.readChunk": PATH,
  "fs.writeChunk": PATH,
  "fs.delete": PATH,
  "fs.duplicate": PATH,
  "fs.watch": FAN_OUT,
  "terminal.create": PATH,
  "terminal.list": PATH,
  "terminal.attach": TERMINAL,
  "terminal.detach": TERMINAL,
  "terminal.input": TERMINAL,
  "terminal.resize": TERMINAL,
  "terminal.close": TERMINAL,
  "git.status": PATH,
  "git.refs": PATH,
  "git.repos": PATH,
  "git.log": PATH,
  "git.commit": PATH,
  "git.fileAt": PATH,
  "git.blame": PATH,
  "git.diff": PATH,
  "git.fetch": PATH,
  "git.branch": PATH,
  "git.push": PATH,
  "git.commitFiles": PATH,
  "git.rollbackPreview": PATH,
  "git.rollback": PATH,
  "git.rollbackHunk": PATH,
  "git.merge": PATH,
  "git.rebase": PATH,
  "git.continue": PATH,
  "git.abort": PATH,
  "git.branchCreate": PATH,
  "git.tagCreate": PATH,
  "git.tagSigning": PATH,
  "git.tagCancel": PATH,
  "git.tag": PATH,
  "git.tagRemote": PATH,
  "git.tagDelete": PATH,
  "git.checkout": PATH,
  "git.commitMenu": PATH,
  "git.undoCommit": PATH,
  "git.revert": PATH,
  "git.cherryPick": PATH,
  "git.reword": PATH,
  "git.rewordCancel": PATH,
  "git.reset": PATH,
  "git.operation": PATH,
  "git.stashList": PATH,
  "git.stashPush": PATH,
  "git.stashApply": PATH,
  "git.stashPop": PATH,
  "git.stashDrop": PATH,
  "git.commitMessage": PATH,
  "git.commitMessageCancel": PATH,
  "git.pull": PATH,
  "worktree.create": PATH,
  "worktree.branches": PATH,
  "worktree.pr": PATH,
  "worktree.status": PATH,
  "worktree.cached": PATH,
  "worktree.cancel": PATH,
  "worktree.remove": PATH,
  "mcp.list": SESSION_OR_PATH,
  "mcp.toggle": SESSION_OR_PATH,
  "mcp.reconnect": SESSION_OR_PATH,
  "mcp.authenticate": SESSION_OR_PATH,
  "mcp.oauthCallback": SESSION_OR_PATH,
  "mcp.clearAuth": SESSION_OR_PATH,
  "mcp.add": PATH,
  "mcp.remove": PATH,
  "skills.list": SESSION_OR_PATH,
  "skills.setState": SESSION_OR_PATH,
  "plugins.list": PATH,
  "plugins.install": PATH,
  "plugins.uninstall": PATH,
  "plugins.setEnabled": PATH,
  "plugins.update": PATH,
  "plugins.reload": PATH,
  "plugins.restart": SESSION,
  "marketplace.list": PATH,
  "marketplace.add": PATH,
  "marketplace.remove": PATH,
  "marketplace.update": PATH,
  "addons.list": HUB,
  "addons.install": HUB,
  "addons.discover": HUB,
  "addons.checkUpdate": HUB,
  "addons.update": HUB,
  "addons.approve": HUB,
  "addons.setEnabled": HUB,
  "addons.setDev": HUB,
  "addons.uninstall": HUB,
  "addons.pickRenderer": HUB,
  "update.check": HUB,
  "update.install": HUB,
  "update.restart": HUB,
  "launcher.shortcut": HUB,
};

/**
 * The route of a message type. An unknown or malformed type is `named`: with an explicit `side` it reaches that Side (a newer Side may know
 * a type this Hub does not), without it the Hub answers `unknown_type`. No other field routes it.
 */
export function routeOf(type: unknown): Route {
  return typeof type === "string" && Object.hasOwn(ROUTES, type) ? ROUTES[type as ClientMessage["type"]] : NAMED;
}
