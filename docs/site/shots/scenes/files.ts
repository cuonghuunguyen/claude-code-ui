// The Files pane: the file tree beside a file open in the editor.
import type { Scene } from "../scene.ts";
import { assistantText, DEMO, DEMO_API, MIN, NOW, session, toolCall, toolResult, userText } from "../demo.ts";

const ID = "5d1c2a10-6f3e-4b7a-9a41-0c2b7e8f1a01";

export const scene: Scene = {
  hash: `#${ID}`,
  sessions: [
    session(ID, { title: "Add coupon codes at checkout", lastActivity: NOW - 4 * MIN }, [
      userText("u1", "Where is the cart total computed?"),
      toolCall("t1", "Read", { file_path: `${DEMO}/src/checkout/cart.ts` }),
      toolResult("t1", "export function cartTotal(items: CartItem[], discount = 0) {}"),
      assistantText("a1", "The total is computed in `src/checkout/cart.ts`: `cartTotal` sums price times quantity and takes an optional discount."),
    ]),
    session("a7e3b9c0-1d24-4f58-8c6a-3e9d5b7a2c02", { title: "Fix the cart badge count", lastActivity: NOW - 3 * 60 * MIN }, [userText("u", "Fix the badge."), assistantText("a", "Fixed.")]),
    session("c3a5e7f9-4b26-4d8a-8f1c-5a2b7d9e4f04", { title: "Upgrade the payment SDK", cwd: DEMO_API, lastActivity: NOW - 26 * 60 * MIN }, [userText("u", "Upgrade."), assistantText("a", "Done.")]),
  ],
  projects: [DEMO, DEMO_API],
  storage: { "claude-ui.tabs": JSON.stringify([ID]), "claude-ui.paneTabs": JSON.stringify({ side: "files" }) },
  steps: async (page) => {
    // Widen the side panel (the tree sits beside the editor from 672px), open src/checkout, keep cart.ts open.
    const sep = page.getByRole("separator", { name: "Resize side panel" });
    await sep.focus();
    for (let i = 0; i < 9; i++) await sep.press("ArrowLeft");
    await page.getByText("src", { exact: true }).first().click();
    await page.getByText("checkout", { exact: true }).first().click();
    await page.getByText("cart.ts", { exact: true }).last().dblclick();
    await page.waitForTimeout(800);
  },
};
