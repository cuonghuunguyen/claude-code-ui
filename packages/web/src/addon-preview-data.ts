// Sample data of the addon preview page (addon-preview.tsx): fixtures only, nothing here talks to a daemon.
// The views are built with the store's own `applyEvent`, so the real components read them like a live session.
import type { ContextUsage, ModelInfo, Part, PlanWindow, SessionInfo, SessionListItem, SessionState } from "@claude-ui/protocol";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { NEW_TAB } from "./tabs.ts";

const CWD = "/home/dev/acme-web";

/** A view made of `parts` in order, as the daemon's events would build it. */
export const viewOf = (parts: Part[], sessionId = "preview"): SessionView => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId, seq: i + 1, part }), emptySession());

export const sessionInfo = (id: string, state: SessionState): SessionInfo => ({ id, cwd: CWD, state, model: "default", permissionMode: "default", effort: "default", permissionModes: ["default", "acceptEdits", "plan"] });

export const MODELS: ModelInfo[] = [{ value: "default", displayName: "Default", description: "Sample model" }];

const user = (id: string, text: string): Part => ({ type: "user_text", id, text, images: [] });
const say = (id: string, text: string, streaming = false): Part => ({ type: "assistant_text", id, text, streaming });
const state = (s: SessionState): Part => ({ type: "session_state", id: "state", state: s });
const call = (id: string, tool: string, input: unknown, status: Extract<Part, { type: "tool_call" }>["status"], extra: Partial<Extract<Part, { type: "tool_call" }>> = {}): Part => ({ type: "tool_call", id, toolUseId: id, tool, input, status, ...extra });

export const CONTEXT: ContextUsage = {
  totalTokens: 84_000,
  maxTokens: 200_000,
  percentage: 42,
  categories: [
    { name: "System prompt", tokens: 12_000, kind: "used" },
    { name: "Tools", tokens: 9_000, kind: "used" },
    { name: "Messages", tokens: 63_000, kind: "used" },
    { name: "Free space", tokens: 116_000, kind: "free" },
  ],
};
const context = (): Part => ({ type: "context_usage", id: "context_usage", usage: CONTEXT });

const ASK = "Rename the helper in the login form and run the tests.";

/** Running: the Thinking row, a streaming reply, the context meter. */
export const running = (): SessionView =>
  viewOf([user("u1", ASK), say("a1", "I will rename `useLogin` to `useSignIn` and run the tests.", true), { type: "thinking", id: "k1", text: "", streaming: true }, context(), state("running")]);

/** Idle after a finished turn. */
export const idle = (): SessionView => viewOf([user("u1", ASK), call("t1", "Bash", { command: "npm test" }, "done"), say("a1", "Done. The helper is renamed and the tests pass."), context(), state("idle")]);

/** One tool card per status: pending, running, done, error, denied, stopped. */
export const tools = (): SessionView =>
  viewOf([
    user("u1", "Show every tool card state."),
    call("c-pending", "Bash", { command: "npm run build" }, "pending"),
    call("c-running", "Bash", { command: "npm test" }, "running"),
    call("c-done", "Edit", { file_path: "/home/dev/acme-web/src/login.ts", old_string: "useLogin", new_string: "useSignIn" }, "done"),
    call("c-error", "Bash", { command: "npm run lint" }, "error"),
    { type: "tool_result", id: "r-error", toolUseId: "c-error", output: "lint failed: 2 errors", isError: true },
    call("c-denied", "Bash", { command: "rm -rf dist" }, "denied", { denial: { by: "classifier", reason: "Deletes files outside the task" } }),
    call("c-stopped", "Bash", { command: "npm run e2e" }, "stopped"),
    state("idle"),
  ]);

/** A permission request waits (phase waiting, send state needs_input, the permission panel). */
export const permission = (): SessionView =>
  viewOf([user("u1", ASK), call("p1", "Bash", { command: "npm run test -- login" }, "running"), { type: "permission_request", id: "perm", requestId: "perm", toolUseId: "p1", tool: "Bash", input: { command: "npm run test -- login" }, suggestions: [], settled: false, at: Date.now() }, state("needs_input")]);

/** The state needs input while no panel asks (the request was answered elsewhere): the prompt box shows and the send button is in state needs_input. */
export const waiting = (): SessionView =>
  viewOf([user("u1", ASK), call("p1", "Bash", { command: "npm run test -- login" }, "running"), { type: "permission_request", id: "perm", requestId: "perm", toolUseId: "p1", tool: "Bash", input: { command: "npm run test -- login" }, suggestions: [], settled: true, at: Date.now() }, state("needs_input")]);

/** A question waits (the question panel). */
export const question = (): SessionView =>
  viewOf([
    user("u1", "Add a sign-out button."),
    { type: "question", id: "ask", requestId: "ask", toolUseId: "q1", questions: [{ question: "Where should the button go?", header: "Placement", options: [{ label: "Header", description: "Top right" }, { label: "Menu", description: "In the account menu" }], multiSelect: false }], settled: false, at: Date.now() },
    state("needs_input"),
  ]);

/** The session ended in an error. */
export const failed = (): SessionView => viewOf([user("u1", ASK), { type: "notice", id: "n1", level: "warning", text: "The session ended with an error." }, state("error")]);

/** The turn of `idle()` still running: the page flips to `idle()` to show `data-just-finished`. */
export const finishing = (): SessionView => viewOf([user("u1", ASK), call("t1", "Bash", { command: "npm test" }, "running"), say("a1", "Running the tests.", true), context(), state("running")]);

const NOW = Date.now();
const item = (id: string, title: string, s: SessionState, minutesAgo: number, cwd = CWD): SessionListItem => ({ ...sessionInfo(id, s), cwd, title, lastActivity: NOW - minutesAgo * 60_000, archived: false, transcript: true });

/** One session per state, in two days so the day headers show. */
export const LIST: SessionListItem[] = [
  item("s-run", "Rename the login helper", "running", 1),
  item("s-need", "Add a sign-out button", "needs_input", 4),
  item("s-idle", "Fix the date format", "idle", 40),
  item("s-error", "Migrate the build script", "error", 90),
  item("s-closed", "Old idea", "closed", 60 * 30),
];

export const PLAN_WINDOWS: PlanWindow[] = [
  { kind: "session", label: "Session", percent: 32, resetsAt: NOW + 2 * 3_600_000, severity: "normal", active: true },
  { kind: "weekly_all", label: "Weekly", percent: 84, resetsAt: NOW + 3 * 86_400_000, severity: "warning", active: false },
  { kind: "weekly_scoped", label: "Opus weekly", percent: 100, resetsAt: NOW + 4 * 86_400_000, severity: "critical", active: false },
];

/** The tab strip: new, running, needs input, unread, idle (the active one). */
export const TABS = [
  { id: NEW_TAB, title: "New session", state: undefined, unread: false },
  { id: "t-run", title: "Rename the login helper", state: "running" as const, unread: false },
  { id: "t-need", title: "Add a sign-out button", state: "needs_input" as const, unread: false },
  { id: "t-unread", title: "Fix the date format", state: "idle" as const, unread: true },
  { id: "t-idle", title: "Docs pass", state: "idle" as const, unread: false },
];

/** Files of the sample project, for the file tree. */
export const FILES: { name: string; path: string; isDir: boolean }[] = [
  { name: "src", path: `${CWD}/src`, isDir: true },
  { name: "package.json", path: `${CWD}/package.json`, isDir: false },
  { name: "README.md", path: `${CWD}/README.md`, isDir: false },
];
export const PROJECT = CWD;

/** Literal samples of the stand-ins and of the active rows (identifiers and code, not words of a language). */
export const SAMPLE = { tab: "t-idle", session: "s-need", status: "connected" as const, branch: "main", file: "src/login.ts", diff: "- useLogin()\n+ useSignIn()", shell: "zsh", output: "$ npm test\n 12 passed" };
