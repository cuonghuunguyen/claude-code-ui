// Plan usage meter (Claude Code /usage): the headline window (the worst one when warning) as ring + percent in the titlebar; click shows every window with its reset time.
import { useEffect, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { TriangleAlertIcon } from "lucide-react";
import type { PlanUsage, PlanWindow } from "@claude-ui/protocol";
import { Ring } from "./context-meter.tsx";

/** A window at or past this percent shows the warning state, also when the server still grades it normal. */
const WARN_PERCENT = 80;

export type PlanLevel = "ok" | "warning" | "limit";
const RANK: PlanLevel[] = ["ok", "warning", "limit"];

const windowLevel = (w: PlanWindow): PlanLevel => (w.percent >= 100 ? "limit" : w.percent >= WARN_PERCENT || w.severity !== "normal" ? "warning" : "ok");

/** The worst window, raised by the last rate_limit_event (rejected = a limit is hit). */
export function planLevel(u: PlanUsage): PlanLevel {
  const status: PlanLevel = u.status === "rejected" ? "limit" : u.status === "allowed_warning" ? "warning" : "ok";
  return [status, ...u.windows.map(windowLevel)].reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a));
}

const STROKE: Record<PlanLevel, string> = { ok: "stroke-ring-progress", warning: "stroke-warning", limit: "stroke-destructive" };
const FILL: Record<PlanLevel, string> = { ok: "bg-ring-progress", warning: "bg-warning", limit: "bg-destructive" };
const TEXT: Record<PlanLevel, string> = { ok: "", warning: "text-warning", limit: "text-destructive" };

function duration(ms: number) {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor(m / 60) % 24}h`;
}

// Made once: toLocaleTimeString with options builds a formatter on every call (~1 ms each), and every render of a meter formats.
const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "Resets 13:40 (in 2h 5m)": time only today, weekday and date otherwise. */
export function resetText(at: number, now = Date.now()) {
  if (at <= now) return "Resets now";
  const d = new Date(at);
  const time = TIME.format(d);
  const day = d.toDateString() === new Date(now).toDateString() ? "" : `${DAY.format(d)} `;
  return `Resets ${day}${time} (in ${duration(at - now)})`;
}

/** Date.now(), updated every `ms` while `on`: relative reset times count down. */
export function useNow(ms: number, on: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

/** "Limit reached" plus the window when the server named it. */
const limitText = (u: PlanUsage) => `Limit reached${u.statusLimit ? `: ${u.statusLimit}` : ""}`;

const lower = (s: string) => s[0]!.toLowerCase() + s.slice(1);

const NAME: Record<PlanLevel, string> = { ok: "Plan usage", warning: "Plan usage warning", limit: "Plan usage limit reached" };

/** The server's headline window; in a warning or limit state the highest window in that state, so the number matches the icon. */
function headline(windows: PlanWindow[], level: PlanLevel) {
  const worst = level === "ok" ? [] : windows.filter((w) => windowLevel(w) === level);
  return worst.reduce((a, w) => (w.percent > a.percent ? w : a), worst[0]!) ?? windows.find((w) => w.active) ?? windows[0];
}

/** Every window with its reset time; a Popover.Root child (titlebar meter, status bar). */
export function PlanPopup({ usage, side }: { usage: PlanUsage; side: "top" | "bottom" }) {
  const limited = usage.status === "rejected";
  // Mounted only while open: "in 2h 5m" stays current while it shows.
  const now = useNow(15_000, true);
  return (
  <Popover.Portal>
    <Popover.Positioner side={side} align="end" sideOffset={6} className="z-50">
      <Popover.Popup
        data-testid="plan-usage"
        className="w-72 max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      >
        <div className="flex items-baseline justify-between gap-2">
          <Popover.Title className="font-medium">Plan usage</Popover.Title>
          {usage.plan && <span className="text-muted-foreground text-xs">{`${usage.plan[0]!.toUpperCase()}${usage.plan.slice(1)} plan`}</span>}
        </div>
        {limited && (
          <p data-testid="plan-limit" className="mt-2 flex items-start gap-1.5 text-destructive text-xs">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden />
            {`${limitText(usage)}.${usage.statusResetsAt ? ` ${resetText(usage.statusResetsAt, now)}` : ""}`}
          </p>
        )}
        <ul className="mt-3 flex flex-col gap-3">
          {usage.windows.map((w) => {
            const l = windowLevel(w);
            return (
              <li key={`${w.kind}:${w.label}`} data-testid="plan-window" data-level={l} className="flex flex-col gap-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{w.label}</span>
                  {/* The server can grade a low percent as warning: not color only. */}
                  {l !== "ok" && <TriangleAlertIcon role="img" aria-label={l === "limit" ? "limit reached" : "warning"} className={`size-3 shrink-0 ${TEXT[l]}`} />}
                  <span className={`tabular-nums ${TEXT[l]}`}>{`${w.percent}%`}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
                  <div className={`h-full rounded-full ${FILL[l]}`} style={{ width: `${Math.min(w.percent, 100)}%` }} />
                </div>
                {w.resetsAt && <span className="text-muted-foreground tabular-nums">{resetText(w.resetsAt, now)}</span>}
              </li>
            );
          })}
        </ul>
      </Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>
  );
}

export function PlanMeter({ usage }: { usage: PlanUsage }) {
  const level = planLevel(usage);
  const head = headline(usage.windows, level);
  const limited = usage.status === "rejected";
  const summary = limited
    ? `Plan usage: ${lower(limitText(usage))}${usage.statusResetsAt ? `, ${lower(resetText(usage.statusResetsAt))}` : ""}`
    : `${NAME[level]}: ${head ? `${head.label} ${head.percent}%${head.resetsAt ? `, ${lower(resetText(head.resetsAt))}` : ""}` : "no windows"}`;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`${summary}, show details`}
        title={summary}
        data-testid="plan-meter"
        data-level={level}
        className={`flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs tabular-nums outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent max-md:h-11 pointer-coarse:h-11 ${level === "ok" ? "text-muted-foreground hover:text-foreground data-popup-open:text-foreground" : TEXT[level]}`}
      >
        {/* Color is not the only signal: the warning and limit states add an icon. */}
        {level === "ok" ? (
          <Ring percent={head?.percent ?? 0} progress={STROKE[level]} />
        ) : (
          <TriangleAlertIcon className="size-3.5 shrink-0" data-testid="plan-warning-icon" aria-hidden />
        )}
        {head ? `${head.percent}%` : "–"}
      </Popover.Trigger>
      <PlanPopup usage={usage} side="bottom" />
    </Popover.Root>
  );
}
