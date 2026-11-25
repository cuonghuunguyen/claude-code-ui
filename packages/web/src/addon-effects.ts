// Addon effects (capability `ui.effect`, docs/spec.md "Addon effects"): the pure rules of the effect host (addon-effects.tsx). No DOM writes here.
import type { EffectState } from "@claude-ui/addon-sdk";
import { EFFECT_TARGETS, MAX_EFFECT_FRAMES, effectAttrs, type AddonEffect, type AddonInfo } from "@claude-ui/protocol";
import { enabledAddons } from "./addons.ts";

/** Canvas area cap after the pixel ratio, and the ratio cap. */
export const MAX_EFFECT_PIXELS = 1_200_000;
export const MAX_EFFECT_DPR = 2;
/** Watchdog: a frame whose reported mean cost stays above this many ms for WATCH_MS is removed. */
export const FRAME_BUDGET_MS = 8;
export const WATCH_MS = 10_000;
/** Reports come every 2 s: this many cover WATCH_MS. */
const WATCH_REPORTS = WATCH_MS / 2000;
/** Longest wait for `effect.done` after `effect.fade`. */
export const FADE_MS = 1000;

export type EffectSpec = { addon: AddonInfo; effect: AddonEffect };

/** The effects that may run: of enabled addons that were granted `ui.effect`, with a v1 target. */
export const effectSpecs = (addons: AddonInfo[]): EffectSpec[] =>
  enabledAddons(addons)
    .filter((a) => a.approved.includes("ui.effect"))
    .flatMap((addon) => (addon.manifest!.effects ?? []).filter((e) => (EFFECT_TARGETS as readonly string[]).includes(e.target)).map((effect) => ({ addon, effect })));

export const specKey = (s: EffectSpec) => `${s.addon.name}:${s.effect.id}`;

/** The attributes the host reads and sends for an effect: those named in `when` and `watch` that the target publishes; any other is never read. */
export function watchedAttrs(e: AddonEffect): string[] {
  const pub = effectAttrs(e.target);
  const named = [...Object.keys(e.when ?? {}).flatMap((k) => (k.startsWith("attr:") ? [k.slice(5)] : [])), ...(e.watch ?? [])];
  return [...new Set(named)].filter((a) => pub.includes(a));
}

/** Whether `state` meets every key of `when` (absent: always). An attribute the target does not publish reads as absent. */
export function whenMatches(when: AddonEffect["when"], state: EffectState): boolean {
  for (const [k, v] of Object.entries(when ?? {})) {
    if (k === "focus-within" || k === "hover") {
      if (state[k] !== v) return false;
      continue;
    }
    const a = state.attrs[k.slice(5)] ?? null;
    if (v === true ? a === null : v === false ? a !== null : a !== v) return false;
  }
  return true;
}

/** The pixel ratio an effect draws at: the device's, at most 2, lowered so the canvas (CSS size times ratio squared) stays within 1.2 megapixels. */
export function effectDpr(width: number, height: number, device: number): number {
  const d = Math.min(Number.isFinite(device) && device > 0 ? device : 1, MAX_EFFECT_DPR);
  const area = Math.max(1, width) * Math.max(1, height);
  return Math.floor(Math.min(d, Math.sqrt(MAX_EFFECT_PIXELS / area)) * 1000) / 1000;
}

/** Candidates in DOM order, capped: one frame per (addon, target element), at most MAX_EFFECT_FRAMES per addon. */
export function capFrames<T extends { spec: EffectSpec; el: object }>(candidates: T[]): T[] {
  const per = new Map<string, number>();
  const taken = new Map<object, Set<string>>();
  return candidates.filter(({ spec, el }) => {
    const name = spec.addon.name;
    const on = taken.get(el) ?? new Set<string>();
    if (on.has(name) || (per.get(name) ?? 0) >= MAX_EFFECT_FRAMES) return false;
    taken.set(el, on.add(name));
    per.set(name, (per.get(name) ?? 0) + 1);
    return true;
  });
}

/** Watchdog verdict: the reports of the last WATCH_MS cover it (one per 2 s) and each mean is over FRAME_BUDGET_MS. Returns the reports still in the window. */
export function watchdog(reports: { at: number; ms: number }[], now: number): { kept: { at: number; ms: number }[]; over: boolean } {
  const kept = reports.filter((r) => now - r.at < WATCH_MS + 1000);
  return { kept, over: kept.length >= WATCH_REPORTS && kept.every((r) => r.ms > FRAME_BUDGET_MS) };
}
