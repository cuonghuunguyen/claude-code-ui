// Context window meter (OpenCode context ring + Context Breakdown): used / max tokens and percent; click shows the categories.
import { useId } from "react";
import { Popover } from "@base-ui/react/popover";
import type { ContextUsage } from "@claude-ui/protocol";
import type { Totals } from "./status-bar.tsx";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");
const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
const share = (tokens: number, max: number) => `${((tokens / max) * 100).toFixed(1)}%`;

const COLORS = [1, 2, 3, 4, 5, 6].map((i) => `var(--context-${i})`);
// Per category name (Claude Code /context), so a category keeps its colour when another one is absent (no MCP row).
const SLOTS: Record<string, number> = { Messages: 0, "System prompt": 1, "System tools": 2, "MCP tools": 3, "Memory files": 4, Skills: 5 };
/** Colour of a category: its fixed slot, else one picked from its name; free space and buffer are faint. */
const colorOf = ({ name, kind }: ContextUsage["categories"][number]) =>
  kind !== "used" ? "var(--faint)" : COLORS[SLOTS[name] ?? [...name].reduce((h, ch) => h + ch.charCodeAt(0), 0) % COLORS.length];

/** OpenCode ProgressCircle v2: 14px, stroke 1.5, from 12 o'clock. `progress`: the stroke class of the filled arc. */
export function Ring({ percent, progress = "stroke-ring-progress" }: { percent: number; progress?: string }) {
  const r = 6.25;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 14 14" className="size-3.5 shrink-0 -rotate-90" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="1.5" className="stroke-ring-track" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="1.5"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(percent, 100) / 100)}
        className={`${progress} transition-[stroke-dashoffset] duration-350 ease-[cubic-bezier(0.65,0,0.35,1)] motion-reduce:transition-none`}
      />
    </svg>
  );
}

/** The breakdown popup; a Popover.Root child (context meter, status bar). */
/** `stats`: the session's token totals, shown like OpenCode's Context tab stats; none before the first turn result. */
export function ContextPopup({ usage, side, stats }: { usage: ContextUsage; side: "top" | "bottom"; stats?: Totals }) {
  const { totalTokens, maxTokens, percentage, categories } = usage;
  const tokens = `${full.format(totalTokens)} / ${full.format(maxTokens)} tokens · ${percentage}%`;
  return (
  <Popover.Portal>
    <Popover.Positioner side={side} align="end" sideOffset={6} className="z-50">
      <Popover.Popup
        data-testid="context-breakdown"
        className="w-72 max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none"
      >
        <Popover.Title className="font-medium">Context window</Popover.Title>
        <p className="mt-0.5 text-[12px] text-muted-foreground tabular-nums">{tokens}</p>
        {stats && (
          // OpenCode Context tab Stat: 12px label (weak) over 12px value (strong), two columns.
          <div data-testid="context-stats" className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] tabular-nums">
            {(
              [
                ["Input tokens", full.format(stats.uncached)],
                ["Output tokens", full.format(stats.output)],
                ["Cache tokens (read/write)", `${full.format(stats.cached)} / ${full.format(stats.cacheWrite)}`],
                ["Total cost", stats.cost === undefined ? "—" : usd.format(stats.cost)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </div>
        )}
        <div data-testid="context-bar" className="mt-3 flex h-2 overflow-hidden rounded-full bg-secondary" aria-hidden>
          {/* Buffer and free space fill the rest of the window; they are not in totalTokens. */}
          {categories.map((c) =>
            c.kind !== "used" ? null : <span key={c.name} title={c.name} style={{ width: share(c.tokens, maxTokens), background: colorOf(c) }} />,
          )}
        </div>
        <ul className="mt-3 flex flex-col gap-1.5">
          {categories.map((c) => (
            <li key={c.name} className="flex items-center gap-2 text-[12px]">
              <span className="size-2 shrink-0 rounded-full" style={{ background: colorOf(c) }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="tabular-nums">{full.format(c.tokens)}</span>
              <span className="w-12 text-right text-muted-foreground tabular-nums">{share(c.tokens, maxTokens)}</span>
            </li>
          ))}
        </ul>
      </Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>
  );
}

export function ContextMeter({ usage, stats }: { usage: ContextUsage; stats?: Totals }) {
  const { totalTokens, maxTokens, percentage } = usage;
  const tip = useId();
  const rows: [string, string][] = [
    ["Tokens", `${full.format(totalTokens)} / ${full.format(maxTokens)}`],
    ["Usage", `${percentage}%`],
    ...(stats?.cost === undefined ? [] : [["Cost", usd.format(stats.cost)] as [string, string]]),
  ];
  return (
    <Popover.Root>
      {/* OpenCode context tooltip (rows name / value) on hover and keyboard focus, so used / max shows where the toolbar has room only for the percent. */}
      <span className="group relative flex shrink-0">
        <span
          id={tip}
          role="tooltip"
          className="pointer-events-none absolute right-0 bottom-full z-50 mb-2 hidden w-max min-w-40 flex-col gap-1 rounded-md bg-popover px-3 py-2 text-[12px] text-popover-foreground tabular-nums shadow-floating group-hover:flex group-has-focus-visible:flex group-has-data-popup-open:hidden! pointer-coarse:hidden!"
        >
          {rows.map(([name, value]) => (
            <span key={name} className="flex items-center gap-4">
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto">{value}</span>
            </span>
          ))}
        </span>
        <Popover.Trigger
          aria-label={`Context window: ${full.format(totalTokens)} of ${full.format(maxTokens)} tokens (${percentage}%), show breakdown`}
          aria-describedby={tip}
          data-testid="context-meter"
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs tabular-nums hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none data-popup-open:bg-accent data-popup-open:text-foreground pointer-coarse:h-11"
        >
          <Ring percent={percentage} />
          {/* Narrow toolbar (phone, pane beside panels): percent only, so the choosers keep one row; tooltip and popover have the numbers. */}
          <span className="hidden @[40rem]:inline">{`${compact.format(totalTokens)} / ${compact.format(maxTokens)} · `}</span>
          {`${percentage}%`}
        </Popover.Trigger>
      </span>
      <ContextPopup usage={usage} side="top" stats={stats} />
    </Popover.Root>
  );
}
