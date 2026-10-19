// A session waiting on a permission prompt for a file edit.
import type { Scene } from "../scene.ts";
import { assistantText, DEMO, DEMO_API, MIN, NOW, PANE_CHANGES, SOURCES, session, toolCall, toolResult, userText } from "../demo.ts";

const ID = "5d1c2a10-6f3e-4b7a-9a41-0c2b7e8f1a01";
const file = `${DEMO}/src/checkout/coupons.ts`;
const edit = {
  file_path: file,
  old_string: "export function applyCoupon(total: number, coupon?: Coupon) {\n  return total;\n}",
  new_string:
    "export function applyCoupon(total: number, coupon: Coupon | undefined, now = Date.now()) {\n  if (!coupon) return total;\n  if (coupon.expiresAt < now) throw new Error(`Coupon ${coupon.code} has expired`);\n  return Math.round(total * (1 - coupon.percent / 100));\n}",
};

const sessions = [
  session(ID, { title: "Add coupon codes at checkout", state: "needs_input", lastActivity: NOW - MIN }, [
    userText("u1", "Add coupon codes to the checkout. A code takes a percentage off the cart total, and an expired code should show a clear message."),
    assistantText("a1", "I'll start by reading how the cart total is computed, then add an `applyCoupon` helper next to it."),
    toolCall("t1", "Read", { file_path: `${DEMO}/src/checkout/cart.ts` }),
    toolResult("t1", "export function cartTotal(items: CartItem[]) {\n  return items.reduce((sum, i) => sum + i.price * i.qty, 0);\n}\n"),
    toolCall("t2", "Grep", { pattern: "coupon", path: `${DEMO}/src` }),
    toolResult("t2", "No matches found"),
    toolCall("t0", "Edit", { file_path: `${DEMO}/src/checkout/cart.ts`, old_string: "export function cartTotal(items: CartItem[]) {", new_string: "export function cartTotal(items: CartItem[], discount = 0) {" }),
    { type: "tool_result", id: "t0:result", toolUseId: "t0", output: "The file src/checkout/cart.ts has been updated.", isError: false, original: SOURCES["src/checkout/cart.ts"]!.before },
    assistantText("a2", "No coupon support exists yet. I'll add the discount rule and the expiry check in `src/checkout/coupons.ts`."),
    toolCall("t3", "Edit", edit, "pending"),
    {
      type: "permission_request",
      id: "perm1",
      requestId: "perm1",
      toolUseId: "t3",
      tool: "Edit",
      input: edit,
      suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      settled: false,
      at: NOW - MIN,
    },
  ]),
  session("a7e3b9c0-1d24-4f58-8c6a-3e9d5b7a2c02", { title: "Fix the cart badge count", lastActivity: NOW - 25 * MIN }, [userText("u", "The cart badge shows 0 after a refresh."), assistantText("a", "Fixed: the count is now read from the stored cart.")]),
  session("b2f4d6e8-3a15-4c79-9e0b-4f1a6c8d3e03", { title: "Write product page tests", lastActivity: NOW - 3 * 60 * MIN }, [userText("u", "Add tests for the product page."), assistantText("a", "Added 6 tests.")]),
  session("c3a5e7f9-4b26-4d8a-8f1c-5a2b7d9e4f04", { title: "Upgrade the payment SDK", cwd: DEMO_API, lastActivity: NOW - 26 * 60 * MIN }, [userText("u", "Upgrade the payment SDK."), assistantText("a", "Upgraded to the latest version.")]),
];

export const scene: Scene = {
  hash: `#${ID}`,
  themes: ["light", "dark"],
  sessions,
  projects: [DEMO, DEMO_API],
  storage: { "claude-ui.diffStyle": "unified", "claude-ui.tabs": JSON.stringify([ID]), "claude-ui.paneTabs": PANE_CHANGES },
};
