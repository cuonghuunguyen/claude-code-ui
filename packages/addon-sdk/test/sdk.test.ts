// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { AddonError, call, insertPrompt, on, watchSession, type Part } from "../claude-ui-addon.js";

// In a top-level test window `parent` is the window itself: that is the host here. Requests are caught at postMessage.
const sent: Record<string, unknown>[] = [];
vi.spyOn(window, "postMessage").mockImplementation((m: unknown) => void sent.push(m as Record<string, unknown>));
afterEach(() => void sent.splice(0));
const host = (data: object, source: MessageEventSource | null = window.parent) => window.dispatchEvent(new MessageEvent("message", { data: { v: 1, ...data }, source }));
const flush = () => new Promise((r) => setTimeout(r));

it("handles an event from the host and ignores the same message from another frame", () => {
  const seen: string[] = [];
  const off = on("command.run", (m) => seen.push(m.args));
  const other = document.createElement("iframe");
  document.body.append(other);
  host({ type: "command.run", name: "cmd", args: "from host" });
  host({ type: "command.run", name: "cmd", args: "forged by another frame" }, other.contentWindow);
  host({ type: "command.run", name: "cmd", args: "no source" }, null);
  off();
  host({ type: "command.run", name: "cmd", args: "after off" });
  expect(seen).toEqual(["from host"]);
});

it("sends a request with v, id and type the payload cannot override, and resolves with the result", async () => {
  const p = insertPrompt("hi");
  expect(sent[0]).toMatchObject({ v: 1, type: "prompt.insert", text: "hi" });
  void call("ui.toast", { text: "x", type: "prompt.submit" } as { text: string }); // a field named like an envelope field
  expect(sent[1]).toMatchObject({ type: "ui.toast" });
  host({ id: sent[0]!.id, ok: true, result: {} });
  await expect(p).resolves.toEqual({});
});

it("rejects a refused request with an AddonError that has the code", async () => {
  const p = call("session.read");
  host({ id: sent[0]!.id, ok: false, error: { code: "refused", message: "session.read needs capability session.read" } });
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(AddonError);
  expect(e).toMatchObject({ code: "refused", message: "session.read needs capability session.read" });
});

it("follows the app's light or dark mode", () => {
  host({ type: "init", addon: "a", view: "v", role: "pane", session: "s", theme: "default", mode: "dark" });
  expect(document.documentElement.style.colorScheme).toBe("dark");
  host({ type: "theme.changed", theme: "default", mode: "light" });
  expect(document.documentElement.style.colorScheme).toBe("light");
});

it("watchSession reads the session after init, then merges pushed parts", async () => {
  const text = (id: string, t: string): Part => ({ type: "user_text", id, text: t, images: [] });
  const lists: string[][] = [];
  const off = watchSession((parts) => lists.push(parts.map((p) => (p.type === "user_text" ? p.text : p.type))));
  host({ type: "session.parts", parts: [text("early", "ignored before the read")] });
  host({ type: "init", addon: "a", view: "v", role: "pane", session: "s", theme: "default", mode: "light" });
  expect(sent[0]).toMatchObject({ type: "session.read" });
  host({ id: sent[0]!.id, ok: true, result: { parts: [text("1", "one")] } });
  await flush();
  host({ type: "session.parts", parts: [text("1", "one edited"), text("2", "two")] });
  off();
  expect(lists).toEqual([["one"], ["one edited", "two"]]);
});

it("the example addon's copy of the SDK is the same as packages/addon-sdk", async () => {
  const { readFile } = await import("node:fs/promises");
  // Tests run from the repository root.
  for (const f of ["claude-ui-addon.js", "claude-ui-addon.d.ts"]) expect(await readFile(`examples/addons/example/${f}`, "utf8"), f).toBe(await readFile(`packages/addon-sdk/${f}`, "utf8"));
});
