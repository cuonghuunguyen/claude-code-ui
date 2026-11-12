// The Changes pane on its Uncommitted mode with the commit box: two files checked, a message typed, the untracked file with its red U.
import type { Scene } from "../scene.ts";
import { scene as files } from "./files.ts";
import { DIFF_UNCOMMITTED, PANE_CHANGES } from "../demo.ts";

export const scene: Scene = {
  ...files,
  storage: { ...files.storage, "claude-ui.paneTabs": PANE_CHANGES, "claude-ui.diffMode": DIFF_UNCOMMITTED },
  steps: async (page) => {
    // Widen the side panel, then check two files and type a message.
    const sep = page.getByRole("separator", { name: "Resize side panel" });
    await sep.focus();
    for (let i = 0; i < 9; i++) await sep.press("ArrowLeft");
    await page.waitForSelector('[data-testid="commit-box"]');
    await page.getByTestId("commit-check-all").check();
    await page.getByTestId("commit-message").fill("Add coupon codes to the cart total");
    await page.waitForTimeout(500);
  },
};
