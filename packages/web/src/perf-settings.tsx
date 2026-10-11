// Settings > Performance (docs/spec.md "Performance monitor"): what the daemon measured: event-loop delay and use, slowest requests
// and spans, processes, stalls linked to what was running, memory and the monitor's own cost. The on/off switch is a row of the
// Settings dialog above it. Durations and counts only: nothing here or in the export holds a title, prompt, path or session id.
import { useCallback, useEffect, useRef, useState } from "react";
import type { HistSummary, PerfDaemon, PerfReport, PerfWorst } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { Button } from "@/components/ui/button";
import { WEB_VERSION } from "./version.ts";

const POLL_MS = 5000;
const ms = (v?: number) => (v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : v >= 100 ? `${Math.round(v)} ms` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const mb = (b: number) => `${Math.round(b / 1e6)} MB`;

type Row = { name: string; s: HistSummary };
const top = (...maps: Record<string, HistSummary>[]): Row[] =>
  maps
    .flatMap((m) => Object.entries(m).map(([name, s]) => ({ name, s })))
    .filter((r) => r.s.n > 0)
    .sort((a, b) => (b.s.p95 ?? b.s.max ?? 0) - (a.s.p95 ?? a.s.max ?? 0))
    .slice(0, 5);

function Table({ id, title, rows }: { id: string; title: string; rows: Row[] }) {
  const num = "w-16 px-1 text-right font-normal tabular-nums";
  return (
    <div className="border-t py-2" data-testid={id}>
      <h4 id={`${id}-title`} className="pb-1 text-sm">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">Nothing yet.</p>
      ) : (
        <table aria-labelledby={`${id}-title`} className="w-full table-fixed text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="px-0 text-left font-normal">Name</th>
              <th scope="col" className="w-10 px-1 text-right font-normal">n</th>
              <th scope="col" className={num}>p50</th>
              <th scope="col" className={num}>p95</th>
              <th scope="col" className={num}>Worst</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} data-row className="tabular-nums">
                <th scope="row" className="truncate py-0.5 pr-1 text-left font-normal">{r.name}</th>
                <td className="w-10 px-1 text-right">{r.s.n}</td>
                <td className={num}>{ms(r.s.p50)}</td>
                <td className={num}>{ms(r.s.p95)}</td>
                <td className={num}>{ms(r.s.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const describeEvent = (w: PerfWorst) => {
  switch (w.kind) {
    case "stall":
      return `Stall${w.spans.length ? ` during ${w.spans.map((s) => s.name).join(", ")}` : ""}`;
    case "child":
      return `${w.cmd}${w.sub ? ` ${w.sub}` : ""} for ${w.request}${w.thread === "worker" ? " (thread)" : ""}`;
    case "span":
      return `Span ${w.name}`;
    case "handler":
      return `Request ${w.request}`;
  }
};

/** Two lines (RSS, heap) over the last samples, each scaled to the RSS maximum. */
function Sparkline({ memory }: { memory: PerfDaemon["memory"] }) {
  if (memory.length < 2) return <span className="text-muted-foreground text-xs">Collecting (one sample per 10 s).</span>;
  const max = Math.max(...memory.map((m) => m.rss), 1);
  const pts = (f: (m: PerfDaemon["memory"][number]) => number) => memory.map((m, i) => `${(i / (memory.length - 1)) * 100},${32 - (f(m) / max) * 30 - 1}`).join(" ");
  return (
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="h-8 w-full" role="img" aria-label="Memory over the last minutes: RSS and heap">
      <polyline points={pts((m) => m.rss)} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-primary" />
      <polyline points={pts((m) => m.heapUsed)} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" className="text-muted-foreground" />
    </svg>
  );
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

export function PerformanceSection({ request }: { request: <T>(msg: Request) => Promise<T> }) {
  const [report, setReport] = useState<PerfReport>();
  const [error, setError] = useState<string>();
  const ask = useRef(request);
  ask.current = request;
  const load = useCallback(() => {
    ask.current<PerfReport>({ type: "perf.report" }).then(
      (r) => (setReport(r), setError(undefined)),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const d = report?.daemon;
  const row = (id: string, label: string, value: string, hint?: string) => (
    <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11" data-testid={id}>
      <div className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-muted-foreground text-xs">{hint}</span>}
      </div>
      <span className="shrink-0 text-sm tabular-nums">{value}</span>
    </div>
  );
  const exportJson = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: { web: WEB_VERSION }, report }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `claude-ui-perf-${stamp(new Date())}.json`;
    a.click();
    // Not in the same tick: the download may still be reading the object.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  const clear = () => void ask.current({ type: "perf.clear" }).then(load, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  return (
    <section aria-label="Performance results" className="flex flex-col" data-testid="perf-section">
      {error && <p className="py-2 text-destructive text-xs" role="alert">{error}</p>}
      {!d && !error && <p className="text-muted-foreground text-sm">Loading…</p>}
      {d && (
        <>
          {!d.monitor && <p className="border-t py-2 text-muted-foreground text-xs">The monitor is off: no new data is collected.</p>}
          {row("perf-eld", "Event-loop delay (excess, p95)", ms(d.eld.excessP95), `Delay over the idle floor of ${ms(d.eld.idleP50)}; the worst window was ${ms(d.eld.excessMax)}.`)}
          {row("perf-elu", "Event-loop use", `${(d.elu * 100).toFixed(1)} %`, "Share of the last 10 s the daemon was busy.")}
          <Table id="perf-slowest" title="Slowest requests and spans" rows={top(d.handlers, d.spans)} />
          <Table id="perf-processes" title="Processes" rows={top(d.children)} />
          <div className="border-t py-2" data-testid="perf-events">
            <h4 className="pb-1 text-sm">Slowest events</h4>
            {d.worst.length === 0 ? (
              <p className="text-muted-foreground text-xs">Nothing yet.</p>
            ) : (
              <ul className="text-xs">
                {d.worst.slice(0, 8).map((w, i) => (
                  <li key={i} className="flex gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate">{describeEvent(w)}</span>
                    <span className="shrink-0 tabular-nums">{ms(w.ms)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t py-2" data-testid="perf-memory">
            <div className="flex items-baseline justify-between pb-1">
              <h4 className="text-sm">Memory</h4>
              {d.memory.length > 0 && <span className="text-muted-foreground text-xs tabular-nums">{mb(d.memory.at(-1)!.rss)} RSS · {mb(d.memory.at(-1)!.heapUsed)} heap</span>}
            </div>
            <Sparkline memory={d.memory} />
          </div>
          {row("perf-cost", "Monitor cost", `${ms(d.cost.ownMs)} (${d.cost.wallMs > 0 ? ((d.cost.ownMs / d.cost.wallMs) * 100).toFixed(3) : "0"} %)`, "JavaScript time of the monitor itself. The timer that measures event-loop delay adds a few ms of CPU per 10 s on top, more on some platforms.")}
          <div className="flex gap-2 border-t pt-2">
            <Button variant="outline" onClick={clear} className="max-md:h-11" data-testid="perf-clear">
              Clear
            </Button>
            <Button variant="outline" onClick={exportJson} className="max-md:h-11" data-testid="perf-export">
              Export JSON
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
