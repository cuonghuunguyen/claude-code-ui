// The Settings dialog on its Layout group: the group list under its category headings, the Sidebar, Tabs, Changes and Terminal sections.
import type { Scene } from "../scene.ts";
import { scene as sessions } from "./sessions.ts";

export const scene: Scene = {
  ...sessions,
  storage: { ...sessions.storage, "claude-ui.settingsGroup": "layout" },
  steps: async (page) => {
    await page.getByTestId("open-settings").click();
    await page.waitForSelector('[data-testid="settings-tabs"]');
  },
};
