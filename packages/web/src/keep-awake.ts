// Keep screen awake (GH-361): a Screen Wake Lock held while this page is visible. Per-browser setting, no daemon involved.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type KeepAwakeSetting = { on: boolean; onlyRunning: boolean };
/** off: setting off · held: lock held · idle: on but not wanted now (hidden page, nothing running) · refused: the browser rejected the request · unsupported: no API here. */
export type KeepAwakeStatus = "off" | "held" | "idle" | "refused" | "unsupported";

const KEY = "claude-ui.keepAwake";
const OFF: KeepAwakeSetting = { on: false, onlyRunning: false };
const listeners = new Set<() => void>();
// Storage blocked: the choice lasts while the page is open.
let memory: KeepAwakeSetting = OFF;
// useSyncExternalStore needs a stable snapshot: reuse the object while the stored text is unchanged.
let cache: { raw: string | null; value: KeepAwakeSetting } = { raw: null, value: OFF };

function parse(raw: string | null): KeepAwakeSetting {
  if (!raw) return OFF;
  try {
    const v = JSON.parse(raw) as Partial<KeepAwakeSetting>;
    return { on: v.on === true, onlyRunning: v.onlyRunning === true };
  } catch {
    return OFF;
  }
}

export function loadKeepAwake(): KeepAwakeSetting {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw !== cache.raw) cache = { raw, value: parse(raw) };
    return cache.value;
  } catch {
    return memory;
  }
}

export function saveKeepAwake(v: KeepAwakeSetting) {
  memory = v;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}

export function subscribeKeepAwake(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

export const useKeepAwakeSetting = (): KeepAwakeSetting => useSyncExternalStore(subscribeKeepAwake, loadKeepAwake, () => OFF);

/** The API exists only in a secure context (HTTPS or localhost). */
export const wakeLockSupported = (nav: Navigator = navigator, win: Window = window): boolean => !!win.isSecureContext && "wakeLock" in nav;

type Doc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

/** Holds the lock while wanted and visible; the browser drops it when the page hides, so it asks again on the next show. No retry loop. */
export function createKeepAwake({ wakeLock, doc, onStatus }: { wakeLock: Pick<WakeLock, "request">; doc: Doc; onStatus: (s: KeepAwakeStatus) => void }) {
  let on = false;
  let active = true;
  let sentinel: WakeLockSentinel | undefined;
  let pending = false;
  let refused: string | undefined;
  let disposed = false;
  const visible = () => doc.visibilityState === "visible";
  const wanted = () => on && active && visible();
  const status = (): KeepAwakeStatus => (!on ? "off" : sentinel ? "held" : refused ? "refused" : "idle");
  const emit = () => onStatus(status());
  const drop = () => {
    const s = sentinel;
    sentinel = undefined;
    void s?.release().catch(() => {});
  };
  const sync = () => {
    if (disposed) return;
    if (!wanted()) {
      drop();
      emit();
      return;
    }
    if (!sentinel && !pending && !refused) {
      pending = true;
      wakeLock.request("screen").then(
        (s) => {
          pending = false;
          if (disposed || !wanted()) {
            void s.release().catch(() => {});
            if (!disposed) emit();
            return;
          }
          sentinel = s;
          s.addEventListener("release", () => {
            if (sentinel === s) sentinel = undefined;
            emit();
          });
          emit();
        },
        (e: unknown) => {
          pending = false;
          refused = (e as Error)?.name || "Error";
          emit();
        },
      );
    }
    emit();
  };
  const onVisibility = () => {
    refused = undefined;
    sync();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  return {
    /** `want`: the setting; `running`: false while "only while a session is running" and none runs. */
    update(want: boolean, running = true) {
      if (want !== on || running !== active) refused = undefined;
      on = want;
      active = running;
      sync();
    },
    error: () => refused,
    dispose() {
      disposed = true;
      doc.removeEventListener("visibilitychange", onVisibility);
      drop();
    },
  };
}

/** Setting + controller for App: `anyRunning` gates the lock when "only while running" is set. */
export function useKeepAwake(anyRunning: boolean) {
  const setting = useKeepAwakeSetting();
  const supported = wakeLockSupported();
  const [live, setLive] = useState<{ status: KeepAwakeStatus; error?: string }>({ status: "off" });
  const ctl = useRef<ReturnType<typeof createKeepAwake>>(undefined);
  useEffect(() => {
    if (!supported) return;
    const c = createKeepAwake({ wakeLock: navigator.wakeLock, doc: document, onStatus: (status) => setLive({ status, error: c.error() }) });
    ctl.current = c;
    return () => (c.dispose(), (ctl.current = undefined));
  }, [supported]);
  useEffect(() => ctl.current?.update(setting.on, !setting.onlyRunning || anyRunning), [setting.on, setting.onlyRunning, anyRunning, supported]);
  const status: KeepAwakeStatus = !supported ? "unsupported" : setting.on ? live.status : "off";
  return { status, error: live.error, supported, setting, toggle: () => saveKeepAwake({ ...setting, on: !setting.on }) };
}
