// The guided tour (docs/spec.md "First-use guide"): a modal walkthrough over the real UI. A dimmed page, a spotlight cut around one real control and
// a popover beside it (a bottom sheet on a phone). It explains; it does not click things for the user. Own component, no dependency.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shownPrompt } from "./config-dialog.tsx";
import { trapTab } from "./focus-trap.ts";
import { GUTTER, isVisible, placePopover, resolveAnchor, type GuideHost, type Rect, type Side } from "./guide.ts";
import { adapt, stepById } from "./guide-steps.ts";
import { keyLabels } from "./shortcuts.ts";

const PAD = 4;
const PHONE = 639;

const mq = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;
const reducedMotion = () => mq("(prefers-reduced-motion: reduce)");
const bold = (text: string) => text.split(/\*\*(.+?)\*\*/).map((t, i) => (i % 2 ? <strong key={i} className="font-medium text-foreground">{t}</strong> : <Fragment key={i}>{t}</Fragment>));
const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1");
const same = (a?: Rect, b?: Rect) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

type Target = { el?: HTMLElement; alt: boolean; rect?: Rect };

export type GuideTourProps = {
  /** The steps of this run, fixed when it started: "Step i of N" counts them. */
  ids: string[];
  /** Step to open on (a reload resumes there). */
  start?: string;
  host: GuideHost;
  /** Below md (768px) the sidebar is a closed drawer and steps use their narrow variant. Default: follows the window. */
  narrow?: boolean;
  onStep?: (id: string) => void;
  /** "done": Next on the last step, Done, or the end card's action. "skipped": Skip tour, Esc, Close. */
  onEnd: (outcome: "done" | "skipped") => void;
  /** Where the focus goes at the end instead of where it was (Settings closed first). */
  returnFocus?: () => HTMLElement | null | undefined;
  /** Tests: jsdom has no layout. */
  visible?: (el: Element) => boolean;
};

/** Whether `query` matches now, kept current. */
function useMedia(query: string) {
  const [on, setOn] = useState(() => mq(query));
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const update = () => setOn(m.matches);
    update();
    m.addEventListener?.("change", update);
    return () => m.removeEventListener?.("change", update);
  }, [query]);
  return on;
}

export function GuideTour({ ids, start, host, narrow: forced, onStep, onEnd, returnFocus, visible = isVisible }: GuideTourProps) {
  const media = useMedia("(max-width: 767px)");
  const narrow = forced ?? media;
  const steps = ids.flatMap((id) => stepById(id) ?? []);
  const n = steps.length;
  const [index, setIndex] = useState(() => Math.max(0, steps.findIndex((s) => s.id === start)));
  const step = adapt(steps[Math.min(index, n - 1)]!, narrow);
  const last = index >= n - 1;
  const [target, setTarget] = useState<Target>({ alt: false });
  const [size, setSize] = useState({ width: 320, height: 200 });
  const [view, setView] = useState(() => ({ width: innerWidth, height: innerHeight }));
  const pop = useRef<HTMLDivElement>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);
  const reduced = reducedMotion();

  const next = () => (last ? onEnd("done") : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));
  const skip = () => onEnd("skipped");
  // The document listener runs for the life of the tour: it calls the latest closures.
  const latest = useRef({ next, back, skip });
  latest.current = { next, back, skip };

  // The app behind is inert (neither focus nor a virtual cursor leaves the tour); the focus goes to Next and comes back at the end.
  useEffect(() => {
    // Nothing focused (document.body, e.g. an automatic start): the end goes to the prompt box instead.
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const inerted = [...document.body.children].filter((c) => !c.hasAttribute("data-guide-tour") && !c.hasAttribute("inert"));
    for (const c of inerted) c.setAttribute("inert", "");
    nextBtn.current?.focus();
    return () => {
      for (const c of inerted) c.removeAttribute("inert");
      const shows = (el?: HTMLElement | null) => !!el && el.isConnected && !el.closest("[hidden]") && el.getClientRects().length > 0;
      const to = returnFocus?.() ?? (shows(opener) ? opener : null) ?? shownPrompt();
      (to ?? document.body).focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape") (e.preventDefault(), latest.current.skip());
      else if (e.key === "ArrowRight") (e.preventDefault(), latest.current.next());
      else if (e.key === "ArrowLeft") (e.preventDefault(), latest.current.back());
      else if (e.key === "Tab" && !pop.current?.contains(document.activeElement)) (e.preventDefault(), nextBtn.current?.focus());
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => onStep?.(step.id), [step.id]);
  useEffect(() => nextBtn.current?.focus(), [index]);

  // Anchor: the first visible candidate, else the step's alternative, else none (centered). Re-measured on layout changes.
  const measure = useCallback(() => {
    const main = resolveAnchor(step.anchors, visible);
    const alt = main ? undefined : step.alt && resolveAnchor(step.alt.anchors, visible);
    const el = main ?? alt;
    const r = el?.getBoundingClientRect();
    const rect = r && { left: r.left, top: r.top, width: r.width, height: r.height };
    setTarget((t) => (t.el === el && t.alt === !!alt && same(t.rect, rect) ? t : { el, alt: !!alt, rect }));
    setView((v) => (v.width === innerWidth && v.height === innerHeight ? v : { width: innerWidth, height: innerHeight }));
  }, [step.id, narrow, visible]);

  useLayoutEffect(() => {
    measure();
    resolveAnchor(step.anchors, visible)?.scrollIntoView?.({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    let frame = 0;
    const again = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(measure)));
    addEventListener("resize", again);
    addEventListener("scroll", again, true);
    const poll = setInterval(measure, 500);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener("resize", again);
      removeEventListener("scroll", again, true);
      clearInterval(poll);
    };
  }, [measure]);
  useEffect(() => {
    if (!target.el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(target.el);
    return () => ro.disconnect();
  }, [target.el, measure]);

  useLayoutEffect(() => {
    const el = pop.current;
    if (el && (el.offsetWidth !== size.width || el.offsetHeight !== size.height) && el.offsetWidth) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  });

  const rect = target.rect;
  const sheet = view.width <= PHONE;
  // The alternative counts only if this step has one: `target` can still hold the previous step's for a render.
  const alt = target.alt ? step.alt : undefined;
  const body = alt ? alt.body : step.body;
  const keys = (alt?.keys ?? step.keys).flatMap((id) => {
    const spec = host.keyOf(id);
    return spec ? [{ id, spec }] : [];
  });
  const coarseOnly = !mq("(any-pointer: fine)") && typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;
  const placed = rect && !sheet ? placePopover({ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }, size, view, step.side ?? "bottom") : undefined;
  const dock = sheet ? (rect && rect.top + rect.height / 2 > view.height / 2 ? "top" : "bottom") : undefined;
  const style: React.CSSProperties = sheet
    ? { left: GUTTER, right: GUTTER, ...(dock === "top" ? { top: GUTTER } : { bottom: "calc(16px + env(safe-area-inset-bottom))" }), maxHeight: "50dvh" }
    : placed
      ? { left: placed.left, top: placed.top, width: 320 }
      : { left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: 320 };
  const move = reduced ? "" : "transition-[left,top,width,height] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";
  const arrow = placed && rect && arrowStyle(placed, rect, size);
  const btn = "max-md:h-11 pointer-coarse:h-11";

  return createPortal(
    <div data-guide-tour="">
      {/* Click shield: swallows pointer events; a click outside the popover does nothing. */}
      <div className={`fixed inset-0 z-[1100] ${rect ? "" : "bg-overlay"}`} data-testid="guide-shield" onMouseDown={(e) => e.preventDefault()} />
      {rect && (
        <div
          aria-hidden
          data-testid="guide-spotlight"
          className={`pointer-events-none fixed z-[1100] ${rect.width < 32 || rect.height < 32 ? "rounded-md" : "rounded-lg"} outline-2 outline-offset-2 outline-ring outline-solid ${move}`}
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD, boxShadow: "0 0 0 9999px var(--overlay)" }}
        />
      )}
      <div
        ref={pop}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        aria-describedby="guide-body"
        data-testid="guide-popover"
        data-step={step.id}
        data-placement={sheet ? `sheet-${dock}` : (placed?.side ?? "center")}
        onKeyDown={trapTab}
        className={`fixed z-[1101] flex max-w-[calc(100vw-2rem)] flex-col gap-2 rounded-lg bg-popover p-4 text-popover-foreground shadow-floating ${reduced ? "" : "animate-[guide-in_160ms_ease-out] motion-reduce:animate-none"} ${move}`}
        style={style}
      >
        {arrow && <span aria-hidden data-testid="guide-arrow" className="absolute size-2 rotate-45 bg-popover" style={arrow} />}
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" data-testid="guide-progress">
            Step {index + 1} of {n}
          </span>
          <button
            type="button"
            aria-label="Close tour"
            onClick={skip}
            className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:-m-3 pointer-coarse:size-11"
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <h2 id="guide-title" className="font-medium text-[15px] tracking-[-0.13px]">
          {step.title}
        </h2>
        <div className="min-h-0 overflow-y-auto">
          <p id="guide-body" className="text-[13px] text-muted-foreground leading-5">
            {bold(body)}
          </p>
        </div>
        {keys.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs" data-testid="guide-keys">
            <span>{coarseOnly ? "With a keyboard" : "Shortcut"}</span>
            {keys.map((k, i) => (
              <Fragment key={k.id}>
                <kbd className="flex shrink-0 gap-0.5 font-sans">
                  {keyLabels(k.spec).map((l) => (
                    <span key={l} className="grid h-5 min-w-5 place-items-center rounded-xs bg-kbd px-1 font-medium text-[11px] text-muted-foreground uppercase leading-none">
                      {l}
                    </span>
                  ))}
                </kbd>
                {keys.length > 1 && step.keyNames?.[step.keys.indexOf(k.id)] && <span>{step.keyNames[step.keys.indexOf(k.id)]}{i < keys.length - 1 ? "," : ""}</span>}
              </Fragment>
            ))}
          </div>
        )}
        <div aria-hidden className="flex gap-1.5" data-testid="guide-dots">
          {steps.map((s, i) => (
            <span key={s.id} className={`size-1.5 rounded-full ${i === index ? "bg-foreground" : "bg-faint"}`} />
          ))}
        </div>
        <div className="flex items-center gap-2 pt-1">
          {!last && (
            <Button variant="ghost" size="sm" className={`-ml-2.5 text-muted-foreground ${btn}`} onClick={skip}>
              Skip tour
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {index > 0 && (
              <Button variant="ghost" size="sm" className={`text-muted-foreground ${btn}`} onClick={back}>
                Back
              </Button>
            )}
            {step.action && (
              <Button variant="secondary" size="sm" className={btn} onClick={() => (host[step.action!.run](), onEnd("done"))}>
                {step.action.label}
              </Button>
            )}
            <Button ref={nextBtn} size="sm" className={btn} onClick={next}>
              {step.id === "welcome" ? "Start tour" : last ? "Done" : "Next"}
            </Button>
          </div>
        </div>
        <div className="sr-only" role="status" aria-live="polite" data-testid="guide-live">
          {`Step ${index + 1} of ${n}. ${step.title}. ${plain(body)}`}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The 8px arrow on the popover edge that faces the anchor, level with the anchor's centre. */
function arrowStyle(p: { left: number; top: number; side: Side }, a: Rect, size: { width: number; height: number }): React.CSSProperties {
  const clamp = (v: number, max: number) => Math.max(12, Math.min(v, max - 12));
  if (p.side === "left" || p.side === "right") {
    const top = clamp(a.top + a.height / 2 - p.top, size.height) - 4;
    return p.side === "right" ? { left: -4, top } : { right: -4, top };
  }
  const left = clamp(a.left + a.width / 2 - p.left, size.width) - 4;
  return p.side === "bottom" ? { top: -4, left } : { bottom: -4, left };
}
