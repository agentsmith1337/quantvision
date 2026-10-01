"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { apiGet, INTERVAL_SECONDS, isAbortError, isTransient, type Candle, type Interval } from "@/lib/api";
import { chartPalette } from "@/lib/chart-theme";
import { marketSocket, type Tick } from "@/lib/market-socket";
import { useElementSize } from "@/lib/use-element-size";
import type { Bar, ChartType, DrawingTool, FibDrawing, IndicatorId, TrendDrawing } from "./chart/financial-chart";

export type { ChartType, IndicatorId } from "./chart/financial-chart";

// The chart draws on canvas and touches window at import time; keep it out of the static prerender.
const FinancialChart = dynamic(() => import("./chart/financial-chart"), { ssr: false });

const IST_OFFSET = 19800;
const HISTORY_DAYS: Record<Interval, number> = { "1m": 2, "5m": 10, "15m": 30, "1h": 90, "1d": 730 };

type Props = { symbol: string; interval: Interval; chartType: ChartType; indicators: ReadonlySet<IndicatorId> };

type LoadState = { key: string; status: "retrying" | "ready" | "failed"; attempt: number; error: string | null };
const RETRY_DELAYS = [1000, 2000, 4000];

export function PriceChart({ symbol, interval, chartType, indicators }: Props) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const { resolvedTheme } = useTheme();
  const palette = useMemo(() => chartPalette(resolvedTheme), [resolvedTheme]);
  const step = INTERVAL_SECONDS[interval];

  const [reloadKey, setReloadKey] = useState(0);
  const loadKey = `${symbol}:${interval}:${reloadKey}`;
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [load, setLoad] = useState<LoadState | null>(null);
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const drawingKey = `qv.drawings.${symbol}.${interval}`;
  const [drawings, setDrawings] = useState<StoredDrawings>(() => loadDrawings(drawingKey));

  // Load history (retrying while Angel One rate-limits), then fold live ticks into
  // the latest bar, batched per animation frame.
  useEffect(() => {
    const controller = new AbortController();
    let unsubscribe = () => {};
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let series: Bar[] = [];
    let lastDayVolume: number | null = null;
    let frame = 0;

    const flush = () => {
      frame = 0;
      setBars(series.slice());
    };

    const onTick = (tick: Tick) => {
      const t = tick.ts / 1000;
      // Ticks carry cumulative day volume; attribute the delta to the current bar.
      const volDelta = tick.volume != null && lastDayVolume != null ? Math.max(0, tick.volume - lastDayVolume) : 0;
      if (tick.volume != null) lastDayVolume = tick.volume;
      const last = series.at(-1);
      const lastT = last ? last.date.getTime() / 1000 : null;
      if (lastT != null && t < lastT) return;
      if (lastT != null && t < lastT + step) {
        series[series.length - 1] = { ...last!, high: Math.max(last!.high, tick.ltp), low: Math.min(last!.low, tick.ltp), close: tick.ltp, volume: last!.volume + volDelta };
      } else {
        // Keep the history's bar phase (Angel One hourly bars start at :15).
        const start = lastT != null ? lastT + Math.floor((t - lastT) / step) * step : Math.floor((t + IST_OFFSET) / step) * step - IST_OFFSET;
        series.push({ date: new Date(start * 1000), open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, volume: volDelta });
      }
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const settle = (status: "ready" | "failed", attempt: number, error: string | null) => {
      setBars(series.slice());
      setLoad({ key: loadKey, status, attempt, error });
      unsubscribe = marketSocket.subscribe(symbol, onTick);
    };

    const attempt = (n: number) => {
      apiGet<{ candles: Candle[] }>(`/api/market/candles/${encodeURIComponent(symbol)}?interval=${interval}&days=${HISTORY_DAYS[interval]}`, {
        signal: controller.signal,
      })
        .then(({ candles }) => {
          series = candles.map((c) => ({ date: new Date(c.time * 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          settle("ready", n, null);
        })
        .catch((e: Error) => {
          if (isAbortError(e) || controller.signal.aborted) return;
          if (isTransient(e) && n < RETRY_DELAYS.length) {
            setLoad({ key: loadKey, status: "retrying", attempt: n + 1, error: e.message });
            retryTimer = setTimeout(() => attempt(n + 1), RETRY_DELAYS[n]);
            return;
          }
          settle("failed", n, e.message);
        });
    };
    attempt(0);

    return () => {
      controller.abort();
      unsubscribe();
      if (retryTimer) clearTimeout(retryTimer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [symbol, interval, step, loadKey]);

  const current = load?.key === loadKey ? load : null;
  const shownBars = current?.status === "ready" || current?.status === "failed" ? bars : null;
  const indexed = useMemo(() => (shownBars ? toIndexed(drawings, shownBars, step) : { trends: [], fibs: [] }), [drawings, shownBars, step]);

  const saveDrawings = (next: StoredDrawings) => {
    setDrawings(next);
    try {
      localStorage.setItem(drawingKey, JSON.stringify(next));
    } catch {}
  };

  // Esc drops the active drawing tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTool("cursor");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const drawingCount = drawings.trends.length + drawings.fibs.length;
  const fontFamily = typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily;
  const retry = () => setReloadKey((k) => k + 1);

  return (
    <div className="flex h-full w-full">
      <DrawingToolbar
        tool={tool}
        onTool={setTool}
        canUndo={drawingCount > 0}
        onUndo={() => saveDrawings(undoLast(drawings))}
        onClear={() => saveDrawings({ trends: [], fibs: [] })}
      />
      <div ref={containerRef} className="relative min-w-0 flex-1">
        {shownBars && shownBars.length > 0 && size.width > 0 && size.height > 0 && (
          <div className="absolute inset-0">
            <ChartErrorBoundary resetKey={loadKey} onRetry={retry}>
              <FinancialChart
                width={size.width}
                height={size.height}
                seriesName={`${symbol}-${interval}`}
                bars={shownBars}
                intraday={interval !== "1d"}
                chartType={chartType}
                indicators={indicators}
                tool={tool}
                trends={indexed.trends}
                fibs={indexed.fibs}
                onTrendsChange={(trends) => saveDrawings({ ...drawings, trends: trends.map((d) => storeTrend(d, shownBars, step)) })}
                onFibsChange={(fibs) => saveDrawings({ ...drawings, fibs: fibs.map((d) => storeFib(d, shownBars, step)) })}
                onToolDone={() => setTool("cursor")}
                palette={palette}
                fontFamily={fontFamily}
              />
            </ChartErrorBoundary>
          </div>
        )}
        {(!current || current.status === "retrying") && (
          <ChartLoading
            symbol={symbol}
            note={current?.status === "retrying" ? `Angel One is busy (1 request/second). Retrying… (${current.attempt}/${RETRY_DELAYS.length})` : null}
          />
        )}
        {current?.status === "failed" &&
          (shownBars?.length ? (
            <div className="absolute right-3 top-3 z-10 flex items-center gap-3 rounded-lg border border-down/40 bg-surface px-3 py-2 text-xs shadow-lg">
              <span className="text-down">Price history unavailable; showing live ticks only.</span>
              <button onClick={retry} className="font-medium text-accent hover:underline">
                Retry
              </button>
            </div>
          ) : (
            <div className="absolute inset-0 grid place-items-center p-6">
              <div className="max-w-sm rounded-xl border border-border bg-surface p-5 text-center shadow-lg">
                <div className="text-sm font-medium">Couldn&apos;t load {symbol} price history</div>
                <p className="mt-1 text-xs text-muted">{current.error}</p>
                <button onClick={retry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg">
                  Retry
                </button>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

/** Animated placeholder candles while history loads (or waits on Angel One's rate limit). */
function ChartLoading({ symbol, note }: { symbol: string; note: string | null }) {
  const heights = [38, 52, 44, 60, 48, 70, 56, 64, 46, 58, 72, 50, 62, 54];
  return (
    <div className="absolute inset-0 grid place-items-center" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <div className="flex h-20 items-end gap-1.5">
          {heights.map((h, i) => (
            <span
              key={i}
              className={`w-2 animate-pulse rounded-sm ${i % 3 === 1 ? "bg-down/50" : "bg-up/50"}`}
              style={{ height: `${h}%`, animationDelay: `${i * 90}ms`, animationDuration: "1.2s" }}
            />
          ))}
        </div>
        <div className="text-center">
          <div className="text-sm text-muted">Loading {symbol}…</div>
          {note && <div className="mt-1 text-xs text-muted">{note}</div>}
        </div>
      </div>
    </div>
  );
}

type BoundaryProps = { resetKey: string; onRetry: () => void; children: React.ReactNode };

/** Keeps a chart failure inside the chart area instead of taking down the page. */
class ChartErrorBoundary extends Component<BoundaryProps, { error: Error | null; key: string }> {
  state = { error: null as Error | null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: { error: Error | null; key: string }) {
    // A new symbol/interval/retry gets a fresh chart.
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error("Chart render failed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-sm rounded-xl border border-border bg-surface p-5 text-center">
          <div className="text-sm font-medium">The chart hit an error</div>
          <p className="mt-1 break-words font-mono text-xs text-muted">{this.state.error.message}</p>
          <button onClick={this.props.onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg">
            Reload chart
          </button>
        </div>
      </div>
    );
  }
}

const TOOLS: { id: DrawingTool; label: string; icon: string }[] = [
  { id: "cursor", label: "Crosshair (Esc)", icon: "M12 3v18M3 12h18" },
  { id: "trendline", label: "Trend line", icon: "M4 20 20 4M4 20a1.5 1.5 0 1 0 0 .01M20 4a1.5 1.5 0 1 0 0 .01" },
  { id: "ray", label: "Ray", icon: "M4 20 21 3M4 20a1.5 1.5 0 1 0 0 .01M17 3h4v4" },
  { id: "fibonacci", label: "Fibonacci retracement", icon: "M3 4h18M3 9h18M3 13h18M3 17h18M3 21h18" },
];

function DrawingToolbar(props: { tool: DrawingTool; onTool: (t: DrawingTool) => void; canUndo: boolean; onUndo: () => void; onClear: () => void }) {
  const btn = "grid size-8 place-items-center rounded-md";
  const icon = (d: string) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" className="size-4" aria-hidden>
      <path d={d} />
    </svg>
  );
  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-border py-2">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          title={t.label}
          aria-label={t.label}
          aria-pressed={props.tool === t.id}
          onClick={() => props.onTool(t.id)}
          className={`${btn} ${props.tool === t.id ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
        >
          {icon(t.icon)}
        </button>
      ))}
      <div className="my-1 w-5 border-t border-border" />
      <button title="Undo last drawing" aria-label="Undo last drawing" disabled={!props.canUndo} onClick={props.onUndo} className={`${btn} text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30`}>
        {icon("M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3")}
      </button>
      <button title="Clear all drawings" aria-label="Clear all drawings" disabled={!props.canUndo} onClick={props.onClear} className={`${btn} text-muted hover:bg-surface-2 hover:text-down disabled:opacity-30`}>
        {icon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3")}
      </button>
    </div>
  );
}

// --- Drawing persistence -------------------------------------------------------
// The chart positions drawings by bar index, which shifts whenever history is
// reloaded. Store them by timestamp instead and map back onto the current bars.

type StoredTrend = { start: [number, number]; end: [number, number]; type: TrendDrawing["type"]; seq: number };
type StoredFib = { x1: number; y1: number; x2: number; y2: number; type: FibDrawing["type"]; seq: number };
type StoredDrawings = { trends: StoredTrend[]; fibs: StoredFib[] };

function loadDrawings(key: string): StoredDrawings {
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { trends: [], fibs: [] };
}

function indexToTime(x: number, bars: Bar[], step: number): number {
  const i = Math.min(Math.max(Math.round(x), 0), bars.length - 1);
  return bars[i].date.getTime() + (x - i) * step * 1000;
}

function timeToIndex(t: number, bars: Bar[], step: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].date.getTime() <= t) lo = mid;
    else hi = mid - 1;
  }
  const offset = (t - bars[lo].date.getTime()) / (step * 1000);
  // Inside the series, snap within the bar; beyond either end, extrapolate.
  return lo === bars.length - 1 || offset < 0 ? lo + offset : lo + Math.min(offset, 0.999);
}

let seqCounter = Date.now();

function storeTrend(d: TrendDrawing & { seq?: number }, bars: Bar[], step: number): StoredTrend {
  return {
    start: [indexToTime(d.start[0], bars, step), d.start[1]],
    end: [indexToTime(d.end[0], bars, step), d.end[1]],
    type: d.type,
    seq: d.seq ?? seqCounter++,
  };
}

function storeFib(d: FibDrawing & { seq?: number }, bars: Bar[], step: number): StoredFib {
  return { x1: indexToTime(d.x1, bars, step), y1: d.y1, x2: indexToTime(d.x2, bars, step), y2: d.y2, type: d.type, seq: d.seq ?? seqCounter++ };
}

function toIndexed(s: StoredDrawings, bars: Bar[], step: number) {
  if (bars.length === 0) return { trends: [], fibs: [] };
  return {
    trends: s.trends.map((d) => ({ ...d, start: [timeToIndex(d.start[0], bars, step), d.start[1]], end: [timeToIndex(d.end[0], bars, step), d.end[1]] }) as TrendDrawing),
    fibs: s.fibs.map((d) => ({ ...d, x1: timeToIndex(d.x1, bars, step), x2: timeToIndex(d.x2, bars, step) }) as FibDrawing),
  };
}

function undoLast(s: StoredDrawings): StoredDrawings {
  const lastTrend = Math.max(-Infinity, ...s.trends.map((d) => d.seq));
  const lastFib = Math.max(-Infinity, ...s.fibs.map((d) => d.seq));
  return lastTrend > lastFib ? { ...s, trends: s.trends.filter((d) => d.seq !== lastTrend) } : { ...s, fibs: s.fibs.filter((d) => d.seq !== lastFib) };
}
