// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonEffect, AddonInfo } from "@claude-ui/protocol";
import { AddonApiContext, AddonsContext, type AddonApi } from "./addons.ts";
import { capFrames, effectDpr, watchdog, whenMatches, type EffectSpec } from "./addon-effects.ts";
import { AddonEffects } from "./addon-effects.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const BASE = `/addon/${"a".repeat(32)}/fx/`;
const addon = (effects: AddonEffect[], approved = ["ui.effect"]): AddonInfo =>
  ({ name: "fx", source: { kind: "local", path: "/x" }, approved, state: "enabled", base: BASE, manifest: { name: "fx", version: "1", description: "", capabilities: ["ui.effect"], themes: [], views: [], commands: [], renderers: [], effects } }) as AddonInfo;
const aura: AddonEffect = { id: "aura", target: "prompt-box", entry: "fx/aura.html", layer: "above", bleed: 24, when: { "focus-within": true } };

describe("rules", () => {
  const state = (focus: boolean, attrs: Record<string, string | null> = {}) => ({ "focus-within": focus, hover: false, attrs });
  it.each([
    [undefined, state(false), true],
    [{ "focus-within": true }, state(true), true],
    [{ "focus-within": true }, state(false), false],
    [{ "attr:data-state": "running" }, state(false, { "data-state": "running" }), true],
    [{ "attr:data-state": "running" }, state(false, { "data-state": "idle" }), false],
    [{ "attr:data-just-finished": true }, state(false, { "data-just-finished": "" }), true],
    [{ "attr:data-just-finished": true }, state(false, { "data-just-finished": null }), false],
    [{ "attr:data-just-finished": false }, state(false, {}), true],
    [{ "focus-within": true, "attr:data-state": "running" }, state(true, { "data-state": "idle" }), false],
  ])("when %j over %j matches: %s", (when, s, want) => expect(whenMatches(when, s)).toBe(want));

  it("caps the pixel ratio at 2 and the canvas at 1.2 megapixels", () => {
    expect(effectDpr(300, 100, 3)).toBe(2);
    expect(effectDpr(300, 100, 1)).toBe(1);
    const d = effectDpr(1920, 1080, 2);
    expect(d).toBeLessThan(1);
    expect(1920 * 1080 * d * d).toBeLessThanOrEqual(1_200_000);
  });

  it("mounts one frame per addon and target element, three per addon", () => {
    const spec = (name: string, id: string) => ({ addon: { name } as AddonInfo, effect: { id } as AddonEffect }) as EffectSpec;
    const [e1, e2, e3, e4] = [{}, {}, {}, {}];
    const got = capFrames([
      { spec: spec("a", "x"), el: e1 },
      { spec: spec("a", "y"), el: e1 },
      { spec: spec("b", "x"), el: e1 },
      { spec: spec("a", "x"), el: e2 },
      { spec: spec("a", "x"), el: e3 },
      { spec: spec("a", "x"), el: e4 },
    ]);
    expect(got.map((c) => `${c.spec.addon.name}${c.spec.effect.id}${[e1, e2, e3, e4].indexOf(c.el) + 1}`)).toEqual(["ax1", "bx1", "ax2", "ax3"]);
  });

  it("the watchdog trips only after 10 s of reports over 8 ms", () => {
    const at = (ms: number[]) => ms.map((m, i) => ({ at: i * 2000, ms: m }));
    expect(watchdog(at([9, 9, 9, 9]), 6000).over).toBe(false);
    expect(watchdog(at([9, 9, 9, 9, 9]), 8000).over).toBe(true);
    expect(watchdog(at([9, 9, 7, 9, 9]), 8000).over).toBe(false);
  });
});

describe("host", () => {
  let host: HTMLDivElement;
  let r: Root;
  let api: AddonApi;
  const frame = () => document.querySelector<HTMLIFrameElement>('[data-effect="fx:aura"]');
  const tick = () => act(() => new Promise((res) => setTimeout(res, 40)));
  const show = async (a: AddonInfo[]) => {
    await act(async () =>
      r.render(
        <AddonsContext value={{ addons: a, picks: {} }}>
          <AddonApiContext value={api}>
            <div data-part="prompt-box">
              <textarea data-testid="input" />
            </div>
            <AddonEffects />
          </AddonApiContext>
        </AddonsContext>,
      ),
    );
    await tick();
  };
  const fromFrame = (data: object) => act(() => void window.dispatchEvent(new MessageEvent("message", { data: { v: 1, ...data }, source: frame()!.contentWindow })));
  beforeEach(() => {
    api = { insert: vi.fn(), status: vi.fn(), toast: vi.fn(), refused: vi.fn(), log: vi.fn() };
    host = document.createElement("div");
    document.body.append(host);
    r = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => r.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("mounts no frame while the target does not match, a sandboxed frame out of the pointer's and keyboard's way while it does, and none once the addon is disabled", async () => {
    await show([addon([aura])]);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    await act(async () => document.querySelector<HTMLTextAreaElement>('[data-testid="input"]')!.focus());
    await tick();
    const f = frame()!;
    expect(f.getAttribute("src")).toBe(`${BASE}fx/aura.html`);
    expect(f.getAttribute("sandbox")).toBe("allow-scripts");
    expect([f.getAttribute("aria-hidden"), f.tabIndex, f.style.pointerEvents, f.hasAttribute("inert")]).toEqual(["true", -1, "none", true]);
    expect((f.parentElement as HTMLElement).style.pointerEvents).toBe("none");
    await show([{ ...addon([aura]), state: "disabled" }]);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("needs ui.effect approved", async () => {
    await show([addon([{ ...aura, when: undefined }], [])]);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("refuses every bridge request of an effect frame", async () => {
    await show([addon([{ ...aura, when: undefined }])]);
    const reply = vi.spyOn(frame()!.contentWindow!, "postMessage");
    await fromFrame({ id: "r1", type: "session.read" });
    expect(reply).toHaveBeenCalledWith({ v: 1, id: "r1", ok: false, error: { code: "refused", message: "session.read is not available in an effect" } }, "*");
    expect(api.refused).toHaveBeenCalledWith("fx", "session.read", "session.read is not available in an effect");
  });

  it("fades out a frame whose when turned false and removes it on effect.done", async () => {
    await show([addon([aura])]);
    const input = document.querySelector<HTMLTextAreaElement>('[data-testid="input"]')!;
    await act(async () => input.focus());
    await tick();
    const post = vi.spyOn(frame()!.contentWindow!, "postMessage");
    // Loaded: the host sends init on load.
    await act(async () => void frame()!.dispatchEvent(new Event("load")));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "effect.init", bleed: 24, motion: true }), "*");
    await act(async () => input.blur());
    await tick();
    expect(post).toHaveBeenCalledWith({ v: 1, type: "effect.fade" }, "*");
    expect(frame()).not.toBeNull();
    await fromFrame({ type: "effect.done" });
    expect(frame()).toBeNull();
  });

  it("removes an effect that stays over budget for 10 s and shows one toast", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await show([addon([{ ...aura, when: undefined }])]);
    for (let i = 0; i < 5; i++) {
      now = i * 2000;
      await fromFrame({ type: "effect.frameCost", ms: 12 });
    }
    expect(frame()).toBeNull();
    expect(api.toast).toHaveBeenCalledTimes(1);
    expect(api.toast).toHaveBeenCalledWith("fx", expect.stringContaining("aura"));
  });
});
