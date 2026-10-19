// The New session tab on a wide screen: the side panel (Changes, Files, Git graph) and the bottom panel (Terminal) of its project.
import type { Scene } from "../scene.ts";
import { assistantText, DEMO, DIFF_UNCOMMITTED, DEMO_API, MIN, NOW, PANE_CHANGES, session, userText } from "../demo.ts";

const prompt = "\x1b[32mdemo@demo-shop\x1b[0m:\x1b[34m~/demo-shop\x1b[0m$ ";

export const scene: Scene = {
  hash: "#new",
  sessions: [
    session("5d1c2a10-6f3e-4b7a-9a41-0c2b7e8f1a01", { title: "Add coupon codes at checkout", lastActivity: NOW - 25 * MIN }, [userText("u", "Add coupon codes."), assistantText("a", "Done.")]),
    session("a7e3b9c0-1d24-4f58-8c6a-3e9d5b7a2c02", { title: "Fix the cart badge count", lastActivity: NOW - 3 * 60 * MIN }, [userText("u", "Fix the badge."), assistantText("a", "Fixed.")]),
    session("c3a5e7f9-4b26-4d8a-8f1c-5a2b7d9e4f04", { title: "Upgrade the payment SDK", cwd: DEMO_API, lastActivity: NOW - 26 * MIN * 60 }, [userText("u", "Upgrade."), assistantText("a", "Done.")]),
  ],
  projects: [DEMO, DEMO_API],
  storage: { "claude-ui.diffStyle": "unified", "claude-ui.diffMode": DIFF_UNCOMMITTED, "claude-ui.paneTabs": PANE_CHANGES, "claude-ui.terminalOpen": "1", "claude-ui.tabs": JSON.stringify(["new"]) },
  terminals: {
    t1: {
      title: "Terminal 1",
      output:
        `${prompt}git status -sb\r\n## feature/checkout...origin/feature/checkout\r\n M src/checkout/cart.ts\r\n?? src/checkout/coupons.ts\r\n` +
        `${prompt}npm run dev\r\n\r\n> demo-shop@1.4.0 dev\r\n> vite\r\n\r\n  VITE v6.0.1  ready in 412 ms\r\n\r\n  \x1b[32m>\x1b[0m  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m\r\n`,
    },
  },
};
