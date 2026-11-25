// The effect host (capability `ui.effect`, docs/spec.md "Addon effects", ADR 0006): one sandboxed canvas frame per matching target, placed over it
// (`above`) or behind the app (`below`, window only), never under the pointer or the keyboard. The frame gets geometry, state flags, public `data-*`
// attribute values, pulses and theme colours: never text, session data or the token. Pure rules in addon-effects.ts.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { EffectColors, EffectPulse, EffectState, EventMessage } from "@claude-ui/addon-sdk";
import { AddonApiContext, AddonsContext } from "./addons.ts";
import { capFrames, effectDpr, effectSpecs, FADE_MS, specKey, watchdog, watchedAttrs, whenMatches, type EffectSpec } from "./addon-effects.ts";
import { frameUrl } from "./addon-frame.tsx";
import { useT } from "./i18n.ts";
import { useColorTheme, useDark } from "./theme.ts";

type Box = { x: number; y: number; w: number; h: number };
type Live = { key: string; spec: EffectSpec; el: Element; fading: boolean };
/** Per frame, outside React: what was last sent and the watchdog reports. */
type Info = { box: Box; bleed: number; state: string; paused: boolean; loaded: boolean; pulses: Set<EffectPulse>; reports: { at: number; ms: number }[]; fadeTimer?: ReturnType<typeof setTimeout> };

const ids = new WeakMap<Element, number>();
let nextId = 0;
const idOf = (el: Element) => ids.get(el) ?? (ids.set(el, ++nextId), nextId);

const post = (frame: HTMLIFrameElement | undefined, msg: EventMessage) => frame?.contentWindow?.postMessage({ v: 1, ...msg }, "*");

function readState(el: Element, spec: EffectSpec): EffectState {
  const win = spec.effect.target === "window";
  const attrs = Object.fromEntries(watchedAttrs(spec.effect).map((a) => [a, el.getAttribute(a)]));
  return { "focus-within": win ? document.hasFocus() : el.matches(":focus-within"), hover: el.matches(":hover"), attrs };
}

function boxOf(el: Element, win: boolean): Box {
  if (win) return { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}
const offScreen = (b: Box) => b.w <= 0 || b.h <= 0 || b.y + b.h < 0 || b.x + b.w < 0 || b.y > innerHeight || b.x > innerWidth;

/** Resolved colours of the current theme (a probe element turns `var(--x)` and color-mix into a colour the canvas takes). */
function themeColors(): EffectColors {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.append(probe);
  const get = (v: string) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color);
  const c = { primary: get("--primary"), ink: get("--muted-foreground"), bg: get("--background"), fg: get("--foreground"), card: get("--card") };
  probe.remove();
  return c;
}

const frameStyle = (b: Box, bleed: number): CSSProperties => ({ left: b.x - bleed, top: b.y - bleed, width: b.w + 2 * bleed, height: b.h + 2 * bleed });

export function AddonEffects() {
  const addons = useContext(AddonsContext).addons;
  const api = useContext(AddonApiContext);
  const t = useT();
  const dark = useDark();
  const theme = useColorTheme();
  const specs = useMemo(() => effectSpecs(addons), [addons]);
  const [live, setLive] = useState<Live[]>([]);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const info = useRef(new Map<string, Info>());
  /** Effects the watchdog stopped: off until the page reloads. */
  const killed = useRef(new Set<string>());
  const toasted = useRef(new Set<string>());
  const liveRef = useRef(live);
  liveRef.current = live;
  const ctx = useRef({ api, t, dark, specs });
  ctx.current = { api, t, dark, specs };
  const [motion, setMotion] = useState(true);
  const schedule = useRef<() => void>(() => {});

  // An effect of an addon that is gone or disabled leaves in this render, not a frame later.
  const keys = new Set(specs.map(specKey));
  const shown = live.filter((l) => keys.has(specKey(l.spec)) && !killed.current.has(specKey(l.spec)));

  useEffect(() => {
    if (!specs.length) {
      setLive((l) => (l.length ? [] : l));
      return;
    }
    const html = document.documentElement;
    let raf = 0;
    const drop = (key: string) => {
      clearTimeout(info.current.get(key)?.fadeTimer);
      info.current.delete(key);
    };
    const scan = () => {
      raf = 0;
      setMotion(html.dataset.motion !== "off");
      const prev = liveRef.current;
      const active = specs.filter((s) => !killed.current.has(specKey(s)) && (!s.effect.option || html.getAttribute(`data-opt-${s.effect.option}`) === "on"));
      // Fading frames count against the caps first (they are still on screen), then the matching targets in DOM order.
      const cands: { spec: EffectSpec; el: Element; base: string; fading?: Live }[] = prev.filter((l) => l.fading).map((l) => ({ spec: l.spec, el: l.el, base: "", fading: l }));
      for (const spec of active) {
        const els = spec.effect.target === "window" ? [html] : [...document.querySelectorAll(`[data-part=${JSON.stringify(spec.effect.target)}]`)];
        for (const el of els) if (whenMatches(spec.effect.when, readState(el, spec))) cands.push({ spec, el, base: `${specKey(spec)}:${idOf(el)}` });
      }
      const allowed = new Set(capFrames(cands).flatMap((c) => (c.fading ? [] : [c.base])));
      const baseOf = (l: Live) => l.key.slice(0, l.key.lastIndexOf(":"));
      // The frames in place keep their order: moving an iframe in the DOM reloads it. New ones go last.
      const activeKeys = new Set(active.map(specKey));
      const next: Live[] = [];
      for (const l of prev) {
        const there = l.el.isConnected && activeKeys.has(specKey(l.spec));
        if (!there) drop(l.key);
        else if (l.fading || allowed.has(baseOf(l))) next.push(l);
        else {
          // No longer wanted while its target and its effect are still there (only `when` turned false): fade out.
          next.push({ ...l, fading: true });
          const i = info.current.get(l.key);
          if (i) {
            post(frames.current.get(l.key), { type: "effect.fade" });
            i.fadeTimer = setTimeout(() => remove(l.key), FADE_MS);
          }
        }
      }
      const placed = new Set(next.filter((l) => !l.fading).map(baseOf));
      for (const c of cands) if (!c.fading && allowed.has(c.base) && !placed.has(c.base)) (placed.add(c.base), next.push({ key: `${c.base}:${++nextId}`, spec: c.spec, el: c.el, fading: false }));
      // Geometry, state and pause of the frames in place; the new ones get theirs at render and at load.
      for (const l of next) {
        const win = l.spec.effect.target === "window";
        const bleed = win ? 0 : l.spec.effect.bleed;
        const box = boxOf(l.el, win);
        const state = readState(l.el, l.spec);
        const paused = document.hidden || offScreen(box);
        const s = JSON.stringify(state);
        let i = info.current.get(l.key);
        if (!i) {
          info.current.set(l.key, { box, bleed, state: s, paused, loaded: false, pulses: new Set(), reports: [] });
          continue;
        }
        const frame = frames.current.get(l.key);
        if (box.x !== i.box.x || box.y !== i.box.y || box.w !== i.box.w || box.h !== i.box.h) {
          if (frame) Object.assign(frame.style, Object.fromEntries(Object.entries(frameStyle(box, bleed)).map(([k, v]) => [k, `${v}px`])));
          if (i.loaded && (box.w !== i.box.w || box.h !== i.box.h)) post(frame, { type: "effect.rect", rect: { w: box.w, h: box.h }, dpr: effectDpr(box.w + 2 * bleed, box.h + 2 * bleed, devicePixelRatio) });
          i.box = box;
        }
        if (s !== i.state && i.loaded && !l.fading) {
          post(frame, { type: "effect.state", state });
          i.pulses.add("state");
        }
        i.state = s;
        if (paused !== i.paused) {
          if (frame) frame.style.visibility = paused ? "hidden" : "";
          if (i.loaded) post(frame, { type: "effect.pause", paused });
          i.paused = paused;
        }
        if (i.loaded && !l.fading) for (const p of i.pulses) post(frame, { type: "effect.pulse", name: p });
        i.pulses.clear();
      }
      if (next.length !== prev.length || next.some((l, k) => l !== prev[k])) setLive(next);
    };
    const remove = (key: string) => {
      drop(key);
      setLive((l) => l.filter((x) => x.key !== key));
      schedule.current(); // a frame waiting for the slot of this one
    };
    schedule.current = () => void (raf ||= requestAnimationFrame(scan));
    const pulse = (name: EffectPulse) => (e: Event) => {
      for (const l of liveRef.current) if (!l.fading && (l.spec.effect.target === "window" || l.el.contains(e.target as Node))) info.current.get(l.key)?.pulses.add(name);
      schedule.current();
    };
    const onInput = pulse("input");
    const onFocus = pulse("focus");
    const onAny = () => schedule.current();
    const attrs = [...new Set(["data-part", "data-motion", ...specs.flatMap((s) => watchedAttrs(s.effect)), ...specs.flatMap((s) => (s.effect.option ? [`data-opt-${s.effect.option}`] : []))])];
    const mo = new MutationObserver(onAny);
    mo.observe(html, { subtree: true, childList: true, attributes: true, attributeFilter: attrs });
    const ro = new ResizeObserver(onAny);
    ro.observe(html);
    document.addEventListener("input", onInput, true);
    document.addEventListener("focusin", onFocus, true);
    for (const ev of ["focusout", "pointerover", "pointerout", "visibilitychange"]) document.addEventListener(ev, onAny, true);
    addEventListener("scroll", onAny, { capture: true, passive: true });
    addEventListener("resize", onAny);
    addEventListener("blur", onAny);
    addEventListener("focus", onAny);
    scan();
    return () => {
      cancelAnimationFrame(raf);
      schedule.current = () => {};
      mo.disconnect();
      ro.disconnect();
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("focusin", onFocus, true);
      for (const ev of ["focusout", "pointerover", "pointerout", "visibilitychange"]) document.removeEventListener(ev, onAny, true);
      removeEventListener("scroll", onAny, { capture: true });
      removeEventListener("resize", onAny);
      removeEventListener("blur", onAny);
      removeEventListener("focus", onAny);
    };
  }, [specs]);

  // Effect frames send only effect.ready / effect.done / effect.frameCost. Any bridge request is refused: an effect has no session, prompt or toast.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const key = [...frames.current].find(([, f]) => f.contentWindow === e.source)?.[0];
      const l = key && liveRef.current.find((x) => x.key === key);
      if (!key || !l) return;
      const m = e.data as { v?: unknown; id?: unknown; type?: unknown; ms?: unknown };
      if (!m || m.v !== 1 || typeof m.type !== "string") return;
      const frame = frames.current.get(key);
      const { api: a, t: tr } = ctx.current;
      if (typeof m.id === "string") {
        const message = `${m.type} is not available in an effect`;
        a.refused(l.spec.addon.name, m.type, message);
        return frame?.contentWindow?.postMessage({ v: 1, id: m.id, ok: false, error: { code: "refused", message } }, "*");
      }
      if (m.type === "effect.ready" && frame) frame.style.opacity = "1";
      else if (m.type === "effect.done" && l.fading) {
        clearTimeout(info.current.get(key)?.fadeTimer);
        info.current.delete(key);
        setLive((x) => x.filter((y) => y.key !== key));
        schedule.current();
      } else if (m.type === "effect.frameCost" && typeof m.ms === "number" && Number.isFinite(m.ms)) {
        const i = info.current.get(key);
        if (!i) return;
        const now = Date.now();
        const w = watchdog([...i.reports, { at: now, ms: m.ms }], now);
        i.reports = w.kept;
        if (!w.over) return;
        const sk = specKey(l.spec);
        killed.current.add(sk);
        for (const x of liveRef.current) if (specKey(x.spec) === sk) (clearTimeout(info.current.get(x.key)?.fadeTimer), info.current.delete(x.key));
        setLive((x) => x.filter((y) => specKey(y.spec) !== sk));
        if (!toasted.current.has(l.spec.addon.name)) (toasted.current.add(l.spec.addon.name), a.toast(l.spec.addon.name, tr("addons.effectSlow", { effect: l.spec.effect.id })));
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);

  // A window effect behind the app: the panels switch to --panel-alpha while it shows (index.css).
  const below = shown.some((l) => l.spec.effect.layer === "below");
  useLayoutEffect(() => {
    if (!below) return;
    document.documentElement.setAttribute("data-effect-below", "");
    return () => document.documentElement.removeAttribute("data-effect-below");
  }, [below]);

  useEffect(() => () => info.current.forEach((i) => clearTimeout(i.fadeTimer)), []);

  if (!shown.length) return null;
  const mode = dark ? "dark" : "light";
  const frameOf = (l: Live) => {
    const spec = specs.find((s) => specKey(s) === specKey(l.spec)) ?? l.spec;
    const win = spec.effect.target === "window";
    const bleed = win ? 0 : spec.effect.bleed;
    const i = info.current.get(l.key);
    const box = i?.box ?? boxOf(l.el, win);
    return (
      <iframe
        // A theme, mode or reduced-motion change gives a fresh frame and a fresh init.
        key={`${l.key}:${theme}:${mode}:${motion}`}
        ref={(f) => void (f ? frames.current.set(l.key, f) : frames.current.delete(l.key))}
        src={frameUrl(spec.addon, spec.effect.entry)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        aria-hidden="true"
        tabIndex={-1}
        inert
        title=""
        data-testid={`addon-effect-${spec.addon.name}-${spec.effect.id}`}
        data-effect={`${spec.addon.name}:${spec.effect.id}`}
        style={{ position: "absolute", ...frameStyle(box, bleed), border: 0, background: "transparent", colorScheme: mode, pointerEvents: "none", opacity: 0, visibility: i?.paused ? "hidden" : undefined }}
        onLoad={(e) => {
          const f = e.currentTarget;
          const cur = info.current.get(l.key);
          if (!cur) return;
          cur.loaded = true;
          f.style.opacity = "0"; // a reloaded document shows again only once it is ready
          const b = cur.box;
          post(f, { type: "effect.init", rect: { w: b.w, h: b.h }, bleed, dpr: effectDpr(b.w + 2 * bleed, b.h + 2 * bleed, devicePixelRatio), theme: mode, colors: themeColors(), motion });
          post(f, { type: "effect.state", state: JSON.parse(cur.state) as EffectState });
          if (cur.paused) post(f, { type: "effect.pause", paused: true });
          if (l.fading) post(f, { type: "effect.fade" });
        }}
      />
    );
  };
  const layer = (where: "above" | "below") => {
    const list = shown.filter((l) => l.spec.effect.layer === where);
    return list.length ? (
      <div data-effect-layer={where} aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: where === "above" ? 40 : -1, pointerEvents: "none", overflow: "hidden" }}>
        {list.map(frameOf)}
      </div>
    ) : null;
  };
  return (
    <>
      {layer("below")}
      {layer("above")}
    </>
  );
}
