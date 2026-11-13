// The New session tab with the OpenCode engine picked: the Engine chip, the agent and permission choosers, and the model picker open with models grouped by provider and its search field.
import type { ListResult, ModelInfo } from "@claude-ui/protocol";
import { ALL_CAPABILITIES } from "@claude-ui/protocol";
import type { Scene } from "../scene.ts";
import { scene as newSession } from "./new-session.ts";
import { MODES } from "../demo.ts";

const OC = { ...ALL_CAPABILITIES, permissionModes: ["config", "default", "acceptEdits"] as never[], planMeter: false, account: false, agents: true };
const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (OpenCode Zen Big Pickle)", description: "", group: "OpenCode" },
  { value: "opencode/big-pickle", displayName: "Big Pickle", description: "", group: "OpenCode Zen" },
  { value: "opencode/grok-code", displayName: "Grok Code Fast", description: "", group: "OpenCode Zen" },
  ...["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"].map((n) => ({ value: `demo-ai/${n.toLowerCase()}`, displayName: `Demo ${n}`, description: "", group: "Demo AI" })),
];

export const scene: Scene = {
  ...newSession,
  storage: { "claude-ui.tabs": JSON.stringify(["new"]) },
  terminals: undefined,
  replies: {
    "session.list": (): ListResult => ({
      sessions: newSession.sessions.map((s) => s.info),
      projects: newSession.projects,
      recentProjects: [],
      permissionModes: [...MODES],
      engines: [
        { engine: "claude", capabilities: ALL_CAPABILITIES, permissionModes: [...MODES] },
        { engine: "opencode", capabilities: OC, permissionModes: ["config", "default", "acceptEdits"] },
      ],
    }),
    "session.agents": { agents: [{ name: "build", description: "The default agent" }, { name: "plan", description: "Plans, never edits" }] },
    "models.list": (req: { engine?: unknown }) => ({ models: req.engine === "opencode" ? MODELS : [{ value: "default", displayName: "Default (recommended)", description: "" }] }),
  },
  steps: async (page) => {
    await page.getByTestId("engine-chip").click();
    await page.getByRole("option", { name: /OpenCode/ }).click();
    await page.waitForTimeout(400);
    await page.getByTestId("session-model").click();
    await page.waitForTimeout(600);
  },
};
