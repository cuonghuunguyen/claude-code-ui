// The tab bar with two project groups: demo-shop open with several tabs, demo-api collapsed to its chip.
import type { Scene } from "../scene.ts";
import { assistantText, DEMO, DEMO_API, MIN, NOW, session, userText } from "../demo.ts";

const done = (id: string, title: string, ago: number, over: { cwd?: string; state?: "running" | "needs_input" | "idle" } = {}) =>
  session(id, { title, lastActivity: NOW - ago, ...over }, [userText("u", `${title}.`), assistantText("a", "Done.")]);

const sessions = [
  done("5d1c2a10-6f3e-4b7a-9a41-0c2b7e8f1a01", "Add coupon codes at checkout", 2 * MIN),
  done("a7e3b9c0-1d24-4f58-8c6a-3e9d5b7a2c02", "Fix the cart badge count", 25 * MIN, { state: "running" }),
  done("b2f4d6e8-3a15-4c79-9e0b-4f1a6c8d3e03", "Write product page tests", 3 * 60 * MIN),
  done("c3a5e7f9-4b26-4d8a-8f1c-5a2b7d9e4f04", "Upgrade the payment SDK", 26 * 60 * MIN, { cwd: DEMO_API }),
  done("d4b6f8a0-5c37-4e9b-9a2d-6b3c8e0f5a05", "Rotate the API keys", 2 * 24 * 60 * MIN, { cwd: DEMO_API }),
];

export const scene: Scene = {
  hash: `#${sessions[0]!.info.id}`,
  sessions,
  projects: [DEMO, DEMO_API],
  storage: { "claude-ui.tabs": JSON.stringify(sessions.map((s) => s.info.id)), "claude-ui.tab-groups-collapsed": JSON.stringify([DEMO_API]) },
};
