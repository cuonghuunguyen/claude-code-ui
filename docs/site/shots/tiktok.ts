// Stills for the TikTok video (`npm run docs:shots -- --tiktok`): phone shots at 1080x1920 (9:16), desktop shots at 2x for zooms.
// Built from the docs scenes and the invented demo-shop data; never real projects.
import type { Scene } from "./scene.ts";
import { assistantText, DEMO, MIN, NOW, PANE_CHANGES, session, toolCall, userText } from "./demo.ts";
import { scene as focus } from "./scenes/focus.ts";
import { scene as permissions } from "./scenes/permissions.ts";

const PHONE = { viewport: { width: 360, height: 640 }, scale: 3, themes: ["dark", "light"] } satisfies Partial<Scene>;
const DESKTOP = { viewport: { width: 1440, height: 900 }, scale: 2, themes: ["dark", "light"] } satisfies Partial<Scene>;

// A permission for a shell command, as it lands on the phone.
const BASH_ID = "11111111-aaaa-4b7a-9a41-0c2b7e8f1a01";
const bashSessions = [
  session(BASH_ID, { title: "Run the checkout tests", state: "needs_input", lastActivity: NOW - 20_000 }, [
    userText("u", "Run the checkout tests and fix what fails."),
    toolCall("t0", "Read", { file_path: `${DEMO}/src/checkout/cart.test.ts` }),
    assistantText("a", "The coupon test expects a rounded total. I fixed `applyCoupon`; now I run the suite."),
    toolCall("t1", "Bash", { command: "npm run test -- checkout", description: "Run the checkout tests" }, "pending"),
    {
      type: "permission_request",
      id: "p1",
      requestId: "p1",
      toolUseId: "t1",
      tool: "Bash",
      input: { command: "npm run test -- checkout", description: "Run the checkout tests" },
      suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run test *" }], behavior: "allow", destination: "localSettings" }],
      settled: false,
      at: NOW - 20_000,
      tier: "low",
    },
  ]),
];

// One coordinator that split the work over four workers, each in its own worktree.
const COORD = "c0000000-0000-4b7a-9a41-0c2b7e8f1a00";
const worker = (n: number, name: string, title: string, state: "running" | "needs_input" | "idle") =>
  session(`w000000${n}-0000-4b7a-9a41-0c2b7e8f1a0${n}`, { title, state, coordinatorId: COORD, workerName: name, lastActivity: NOW - n * 30_000 }, [userText("u", title), assistantText("a", "On it.")]);
const workerSessions = [
  session(COORD, { title: "Ship the checkout v2", state: "running", coordinator: true, lastActivity: NOW - 10_000 }, [
    userText("u", "Ship checkout v2: coupons, shipping validation, order history and tests. Split it and use a worker for each part."),
    assistantText("a", "I split it into four parts and started a worker for each, every one in its own worktree:\n\n| Worker | Task |\n| --- | --- |\n| coupons | Coupon codes at checkout |\n| shipping | Shipping form validation |\n| history | Order history page |\n| tests | Checkout end-to-end tests |\n\nI'll review each result before I merge it."),
    toolCall("t1", "TodoWrite", { todos: [] }),
  ]),
  worker(1, "coupons", "Coupon codes at checkout", "running"),
  worker(2, "shipping", "Shipping form validation", "running"),
  worker(3, "history", "Order history page", "needs_input"),
  worker(4, "tests", "Checkout end-to-end tests", "running"),
];

// Two sessions side by side.
const A = permissions.sessions[0]!.info.id;
const B = focus.sessions[2]!.info.id;

export const TIKTOK: Record<string, Scene> = {
  "phone-permission": { ...PHONE, hash: `#${BASH_ID}`, sessions: bashSessions, projects: [DEMO], storage: { "claude-ui.tabs": JSON.stringify([BASH_ID]) } },
  "phone-diff": { ...permissions, ...PHONE },
  "phone-focus": { ...focus, ...PHONE },
  "desktop-workers": {
    ...DESKTOP,
    hash: `#${COORD}`,
    sessions: workerSessions,
    projects: [DEMO],
    storage: { "claude-ui.tabs": JSON.stringify([COORD]), "claude-ui.paneTabs": PANE_CHANGES },
    steps: async (page) => void (await page.getByText("4 workers").click()),
  },
  "desktop-split": {
    ...DESKTOP,
    viewport: { width: 1920, height: 1080 },
    hash: `#${A}`,
    sessions: [permissions.sessions[0]!, focus.sessions[2]!],
    projects: permissions.projects,
    storage: { "claude-ui.tabs": JSON.stringify([A, B]), "claude-ui.split": JSON.stringify({ dir: "row", ids: [A, B], at: 0, ratio: 0.5 }) },
  },
  "desktop-workspace": { ...permissions, ...DESKTOP },
  "desktop-focus": { ...focus, ...DESKTOP },
};
