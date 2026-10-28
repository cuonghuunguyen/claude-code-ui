// Shared demo data: one invented project, `demo-shop`, and the helpers scenes build from. Never use real names, paths or text here.
import type { FsEntry, ModelInfo, Part, SessionListItem, SessionState } from "@claude-ui/protocol";
import type { SceneSession } from "./scene.ts";

/** The frozen "now" of every scene (the page clock is fixed to it), so relative times read the same on every run. */
export const NOW = Date.parse("2026-03-12T10:30:00Z");
export const MIN = 60_000;

export const DEMO = "/home/demo/demo-shop";
export const DEMO_API = "/home/demo/demo-api";

export const MODELS: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "Use the default model" },
  { value: "sonnet", displayName: "Sonnet", description: "Fast and capable" },
  { value: "opus", displayName: "Opus", description: "Most capable" },
];

export const MODES = ["default", "acceptEdits", "plan"] as const;

export const listItem = (id: string, over: Partial<SessionListItem> & { title: string }): SessionListItem => ({
  id,
  cwd: DEMO,
  state: "idle",
  model: "default",
  permissionMode: "default",
  effort: "default",
  permissionModes: [...MODES],
  lastActivity: NOW - 5 * MIN,
  archived: false,
  transcript: true,
  ...over,
});

/** A session: its list entry and the parts its timeline holds (a session_state part is appended from `state`). */
export const session = (id: string, over: Partial<SessionListItem> & { title: string }, parts: Part[]): SceneSession => {
  const info = listItem(id, over);
  return { info, parts: [...parts, { type: "session_state", id: `${id}-state`, state: info.state as SessionState }] };
};

export const userText = (id: string, text: string): Part => ({ type: "user_text", id, text, images: [] });
export const assistantText = (id: string, text: string): Part => ({ type: "assistant_text", id, text, streaming: false });
export const toolCall = (id: string, tool: string, input: unknown, status: "done" | "running" | "pending" = "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool, input, status });
export const toolResult = (id: string, output: unknown): Part => ({ type: "tool_result", id: `${id}:result`, toolUseId: id, output, isError: false });

/** The demo project's folders (relative to its root); every project of a scene shares this tree. */
const TREE: Record<string, string[]> = {
  "": ["src/", "public/", ".gitignore", "package.json", "README.md", "tsconfig.json"],
  src: ["checkout/", "components/", "pages/", "main.tsx"],
  "src/checkout": ["cart.ts", "cart.test.ts", "coupons.ts", "ShippingForm.tsx"],
  "src/components": ["Header.tsx", "ProductCard.tsx"],
  "src/pages": ["Home.tsx", "Product.tsx"],
  public: ["favicon.svg"],
};

/** The `fs.list` reply for a directory path under a demo project. */
export function listDir(path: string): { entries: FsEntry[] } {
  const root = [DEMO, DEMO_API].find((r) => path === r || path.startsWith(`${r}/`));
  const rel = root ? path.slice(root.length).replace(/^\//, "") : "";
  return { entries: (TREE[rel] ?? []).map((n) => ({ name: n.replace(/\/$/, ""), path: `${root ?? DEMO}/${rel ? `${rel}/` : ""}${n.replace(/\/$/, "")}`, isDir: n.endsWith("/") })) };
}

/** Side panel on Changes (the default pick is Files). */
export const PANE_CHANGES = JSON.stringify({ side: "changes" });

/** Changes tab on its git "Uncommitted" mode, over the git.diff reply. */
export const DIFF_UNCOMMITTED = "uncommitted";

/** File contents of the demo project: `before` is HEAD, `after` the working tree. Source lines joined with newlines. */
const L = (...lines: string[]) => lines.map((l) => `${l}\n`).join("");
export const SOURCES: Record<string, { before: string; after: string }> = {
  "src/checkout/cart.ts": {
    before: L("export function cartTotal(items: CartItem[]) {", "  return items.reduce((sum, i) => sum + i.price * i.qty, 0);", "}"),
    after: L("export function cartTotal(items: CartItem[], discount = 0) {", "  const sum = items.reduce((total, i) => total + i.price * i.qty, 0);", "  return Math.max(0, sum - discount);", "}"),
  },
  "src/checkout/coupons.ts": {
    before: "",
    after: L("export type Coupon = { code: string; percent: number; expiresAt: number };", "", "export function applyCoupon(total: number, coupon?: Coupon) {", "  return total;", "}"),
  },
  "src/checkout/cart.test.ts": {
    before: L("import { cartTotal } from './cart';", "", "test('sums the items', () => {", "  expect(cartTotal([{ price: 5, qty: 2 }])).toBe(10);", "});"),
    after: L("import { cartTotal } from './cart';", "", "test('sums the items', () => {", "  expect(cartTotal([{ price: 5, qty: 2 }])).toBe(10);", "});", "", "test('never goes below zero', () => {", "  expect(cartTotal([{ price: 5, qty: 1 }], 9)).toBe(0);", "});"),
  },
};
const sourceOf = (path: string) => Object.entries(SOURCES).find(([rel]) => path.endsWith(rel))?.[1];
export const fileAfter = (path: string) => ({ content: sourceOf(path)?.after ?? "", mtime: NOW });
export const fileBefore = (path: string) => ({ content: sourceOf(path)?.before ?? "" });
