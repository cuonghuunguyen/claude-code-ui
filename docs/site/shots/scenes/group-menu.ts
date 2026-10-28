// A compact group chip's right-click menu (Move group, Clean up group, Close other groups, Close group).
import type { Scene } from "../scene.ts";
import { scene as sessions } from "./sessions.ts";

export const scene: Scene = {
  ...sessions,
  storage: { ...sessions.storage, "claude-ui.tabCompact": "1", "claude-ui.tab-groups-collapsed": "[]" },
  steps: async (page) => {
    await page.getByTestId("tab-group-chip").nth(1).click({ button: "right" });
    await page.waitForSelector('[data-testid="tab-group-context-menu"]');
  },
  clip: { x: 0, y: 0, width: 760, height: 330 },
};
