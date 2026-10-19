// The bottom panel with two terminals; the second one is active.
import type { Scene } from "../scene.ts";
import { assistantText, DEMO, DEMO_API, DIFF_UNCOMMITTED, MIN, NOW, PANE_CHANGES, session, userText } from "../demo.ts";

const ID = "5d1c2a10-6f3e-4b7a-9a41-0c2b7e8f1a01";
const prompt = "\x1b[32mdemo@demo-shop\x1b[0m:\x1b[34m~/demo-shop\x1b[0m$ ";

export const scene: Scene = {
  hash: `#${ID}`,
  sessions: [
    session(ID, { title: "Add coupon codes at checkout", lastActivity: NOW - 4 * MIN }, [userText("u1", "Run the checkout tests."), assistantText("a1", "All 14 checkout tests pass.")]),
    session("a7e3b9c0-1d24-4f58-8c6a-3e9d5b7a2c02", { title: "Fix the cart badge count", lastActivity: NOW - 3 * 60 * MIN }, [userText("u", "Fix the badge."), assistantText("a", "Fixed.")]),
    session("c3a5e7f9-4b26-4d8a-8f1c-5a2b7d9e4f04", { title: "Upgrade the payment SDK", cwd: DEMO_API, lastActivity: NOW - 26 * 60 * MIN }, [userText("u", "Upgrade."), assistantText("a", "Done.")]),
  ],
  projects: [DEMO, DEMO_API],
  storage: { "claude-ui.tabs": JSON.stringify([ID]), "claude-ui.terminalOpen": "1", "claude-ui.terminalActive": "t2", "claude-ui.diffStyle": "unified", "claude-ui.diffMode": DIFF_UNCOMMITTED, "claude-ui.paneTabs": PANE_CHANGES },
  terminals: {
    t1: {
      title: "Terminal 1",
      output: `${prompt}npm run dev\r\n\r\n> demo-shop@1.4.0 dev\r\n> vite\r\n\r\n  VITE v6.0.1  ready in 412 ms\r\n\r\n  \x1b[32m>\x1b[0m  Local:   \x1b[36mhttp://localhost:5173/\x1b[0m\r\n`,
    },
    t2: {
      title: "Terminal 2",
      output:
        `${prompt}npm test -- checkout\r\n\r\n \x1b[32m✓\x1b[0m src/checkout/cart.test.ts (6)\r\n \x1b[32m✓\x1b[0m src/checkout/coupons.test.ts (8)\r\n\r\n` +
        ` Test Files  \x1b[32m2 passed\x1b[0m (2)\r\n      Tests  \x1b[32m14 passed\x1b[0m (14)\r\n   Duration  1.82s\r\n\r\n${prompt}`,
    },
  },
};
