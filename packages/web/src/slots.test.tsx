// @vitest-environment jsdom
// Theme slots (GH-870): the loader, done icon and send icon of an addon theme replace the built-in marks while the asset file exists; Thinking phrases replace the label.
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_CAPABILITIES, type AddonInfo } from "@claude-ui/protocol";
import { ToolStatusMark } from "@/components/ai-elements/tool";
import { AddonsContext } from "./addons.ts";
import { setLocalePref } from "./i18n.ts";
import { SlotsProvider, useThinkingPhrase } from "./slots.tsx";
import { applyAddonThemes, applyColorTheme } from "./theme.ts";
import { addonThemes } from "./themes.ts";
import { PromptToolbar } from "./toolbar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
const html = document.documentElement;
const palette = Object.fromEntries(["bg", "card", "side", "fg", "muted", "border", "primary", "pfg", "kw", "str", "fn", "type", "num", "cmt", "varc", "err", "warn", "ok", "info"].map((k) => [k, "#101010"]));
const BASE = `/addon/${"a".repeat(32)}/acme/`;
const SLOTS = { loader: "ring", "done-icon": "tick", "send-icon": "arrow", "thinking-phrases": { en: ["Casting", "Expanding"], vi: ["Đang niệm chú"] } };
const addon = (present: Record<string, boolean>, slots: object = SLOTS): AddonInfo =>
  ({
    name: "acme",
    source: { kind: "local", path: "/x" },
    approved: [],
    state: "enabled",
    base: BASE,
    assets: Object.fromEntries(Object.entries(present).map(([k, p]) => [k, { present: p }])),
    manifest: {
      name: "acme", version: "1", description: "", capabilities: [], views: [], commands: [], renderers: [],
      assets: { ring: { path: "art/ring.svg" }, tick: { path: "art/tick.png" }, arrow: { path: "art/arrow.webp" } },
      themes: [{ id: "void", name: "Void", dark: palette, slots }],
    },
  }) as AddonInfo;

let host: HTMLDivElement;
let r: Root;
const Phrase = ({ turn }: { turn?: string }) => <b data-testid="phrase">{useThinkingPhrase(turn) ?? "Thinking"}</b>;
const toolbar = (over: Partial<ComponentProps<typeof PromptToolbar>> = {}) => (
  <PromptToolbar models={[{ value: "default", displayName: "Default", description: "" }]} caps={ALL_CAPABILITIES} model="default" onModel={() => {}} effort="default" onEffort={() => {}} mode="default" modes={["default"]} onMode={() => {}} onAttach={() => {}} state="idle" hasInput onSend={() => {}} onStop={() => {}} onFocusLost={() => {}} {...over} />
);
const show = async (a: AddonInfo, ui: React.ReactNode = null) => {
  applyAddonThemes(addonThemes([a]));
  await act(async () =>
    r.render(
      <AddonsContext value={{ addons: [a], picks: {} }}>
        <SlotsProvider>
          <ToolStatusMark state="input-available" />
          <ToolStatusMark state="output-available" />
          <Phrase turn="prompt-1" />
          {ui}
        </SlotsProvider>
      </AddonsContext>,
    ),
  );
};
const imgs = (part: string) => [...host.querySelectorAll<HTMLImageElement>(`[data-part="${part}"] img`)];
beforeEach(() => {
  window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as never;
  host = document.createElement("div");
  document.body.append(host);
  r = createRoot(host);
  html.classList.add("dark");
  applyColorTheme("addon:acme:void");
});
afterEach(async () => {
  await act(async () => r.unmount());
  host.remove();
  html.classList.remove("dark");
  html.removeAttribute("data-theme");
  applyAddonThemes([]);
  setLocalePref("system");
});

it("the loader and done icon show the theme's images (decorative, same origin) while the files exist; html says which slots are in effect", async () => {
  await show(addon({ ring: true, tick: true, arrow: true }));
  expect(imgs("loader").map((i) => i.getAttribute("src"))).toEqual([`${BASE}art/ring.svg`]);
  expect(imgs("done-icon").map((i) => i.getAttribute("src"))).toEqual([`${BASE}art/tick.png`]);
  for (const i of [...imgs("loader"), ...imgs("done-icon")]) expect([i.getAttribute("alt"), i.getAttribute("aria-hidden")]).toEqual(["", "true"]);
  expect(host.querySelectorAll("svg")).toHaveLength(0); // the built-in icons are replaced
  expect(["loader", "done-icon", "send-icon", "thinking-phrases"].map((s) => html.hasAttribute(`data-slot-${s}`))).toEqual([true, true, true, true]);
  expect(host.querySelector('[data-part="loader"]')!.closest("[data-state]")!.textContent).toContain("Running"); // the status text for assistive tech stays
});

it("a slot whose file is missing keeps the built-in mark, the theme still applies", async () => {
  await show(addon({ ring: false, tick: true, arrow: false }));
  expect(host.querySelector('[data-part="loader"] svg')).not.toBeNull();
  expect(imgs("loader")).toHaveLength(0);
  expect(imgs("done-icon")).toHaveLength(1);
  expect(["loader", "done-icon", "send-icon"].map((s) => html.hasAttribute(`data-slot-${s}`))).toEqual([false, true, false]);
  await show({ ...addon({ ring: true, tick: true, arrow: true }), manifest: { ...addon({}).manifest!, themes: [{ id: "void", name: "Void", dark: palette }] } } as AddonInfo);
  expect(imgs("loader")).toHaveLength(0);
  expect(html.hasAttribute("data-slot-done-icon")).toBe(false);
});

it("the send icon replaces the arrow and the button keeps its accessible name", async () => {
  await show(addon({ ring: true, tick: true, arrow: true }), toolbar());
  const send = host.querySelector<HTMLElement>('[data-testid="send"]')!;
  expect(send.querySelector("img")!.getAttribute("src")).toBe(`${BASE}art/arrow.webp`);
  expect(send.getAttribute("aria-label")).toBe("Send");
  await show(addon({ ring: true, tick: true, arrow: false }), toolbar());
  expect(host.querySelector('[data-testid="send"] img')).toBeNull();
  expect(host.querySelector('[data-testid="send"] svg')).not.toBeNull();
});

it("Thinking phrases: the UI language picks the list, a turn keeps its phrase, another language without a list keeps the built-in label", async () => {
  setLocalePref("en");
  await show(addon({}));
  const text = () => host.querySelector('[data-testid="phrase"]')!.textContent;
  expect(["Casting", "Expanding"]).toContain(text());
  const first = text();
  await show(addon({}));
  expect(text()).toBe(first);
  setLocalePref("vi");
  await show(addon({}));
  expect(text()).toBe("Đang niệm chú");
  await show(addon({}, { loader: "ring", "thinking-phrases": { en: ["Casting"] } }));
  expect(text()).toBe("Thinking");
  expect(html.hasAttribute("data-slot-thinking-phrases")).toBe(false);
});
