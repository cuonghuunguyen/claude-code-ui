// Context window meter (OpenCode context ring + Context Breakdown): used / max tokens and percent; click shows the categories.
import { Popover } from "@base-ui/react/popover";
import type { ContextUsage } from "@claude-ui/protocol";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat("en");
const share = (tokens: number, max: number) => `${((tokens / max) * 100).toFixed(1)}%`;

const COLORS = [1, 2, 3, 4, 5, 6].map((i) => `var(--context-${i})`);

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
export function ContextPopup({ usage, side }: { usage: ContextUsage; side: "top" | "bottom" }) {
  const { totalTokens, maxTokens, percentage, categories } = usage;
  const tokens = `${full.format(totalTokens)} / ${full.format(maxTokens)} tokens · ${percentage}%`;
  const color = (i: number) => (categories[i]!.kind !== "used" ? "var(--faint)" : COLORS[i % COLORS.length]);
  return (
  <Popover.Portal>
    <Popover.Positioner side={side} align="end" sideOffset={6} className="z-50">
      <Popover.Popup
        data-testid="context-breakdown"
        className="w-72 max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
      >
        <Popover.Title className="font-medium">Context window</Popover.Title>
        <p className="mt-0.5 text-muted-foreground text-xs tabular-nums">{tokens}</p>
        <div data-testid="context-bar" className="mt-3 flex h-2 overflow-hidden rounded-full bg-secondary" aria-hidden>
          {/* Buffer and free space fill the rest of the window; they are not in totalTokens. */}
          {categories.map((c, i) =>
            c.kind !== "used" ? null : <span key={c.name} title={c.name} style={{ width: share(c.tokens, maxTokens), background: color(i) }} />,
          )}
        </div>
        <ul className="mt-3 flex flex-col gap-1.5">
          {categories.map((c, i) => (
            <li key={c.name} className="flex items-center gap-2 text-xs">
              <span className="size-2 shrink-0 rounded-full" style={{ background: color(i) }} aria-hidden />
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

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { totalTokens, maxTokens, percentage } = usage;
  const tokens = `${full.format(totalTokens)} / ${full.format(maxTokens)} tokens · ${percentage}%`;
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={`Context window: ${full.format(totalTokens)} of ${full.format(maxTokens)} tokens (${percentage}%), show breakdown`}
        title={tokens}
        data-testid="context-meter"
        className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs tabular-nums hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none data-popup-open:bg-accent data-popup-open:text-foreground pointer-coarse:h-11"
      >
        <Ring percent={percentage} />
        {/* Narrow toolbar (phone, pane beside panels): percent only, so the choosers keep one row; tooltip and popover have the numbers. */}
        <span className="hidden @[40rem]:inline">{`${compact.format(totalTokens)} / ${compact.format(maxTokens)} · `}</span>
        {`${percentage}%`}
      </Popover.Trigger>
      <ContextPopup usage={usage} side="top" />
    </Popover.Root>
  );
}
