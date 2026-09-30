// Steady-pace reveal of streamed text: network chunks arrive in bursts, the reader sees a constant flow.
import { useEffect, useRef, useState } from "react";

const MIN_CHARS_PER_SEC = 120;
const CATCH_UP_SEC = 0.5; // a large backlog is revealed within about this time

export function nextRevealLength(shown: number, target: number, dtMs: number): number {
  const backlog = target - shown;
  if (backlog <= 0) return target;
  const rate = Math.max(MIN_CHARS_PER_SEC, backlog / CATCH_UP_SEC);
  return Math.min(target, shown + Math.max(1, Math.round((rate * dtMs) / 1000)));
}

/** Returns the prefix of `text` to show now. Text that was never streamed is shown at once. */
export function useSmoothText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(streaming ? 0 : text.length);
  const shownRef = useRef(shown);
  const animate = useRef(streaming);
  if (streaming) animate.current = true;

  useEffect(() => {
    if (!animate.current) return void setShown((shownRef.current = text.length));
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      shownRef.current = nextRevealLength(shownRef.current, text.length, now - last);
      last = now;
      setShown(shownRef.current);
      if (shownRef.current < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);

  return text.slice(0, shown);
}
