"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { apiGet, INTERVAL_SECONDS, type Candle, type Interval } from "@/lib/api";
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

export function PriceChart({ symbol, interval, chartType, indicators }: Props) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const { resolvedTheme } = useTheme();
  const palette = useMemo(() => chartPalette(resolvedTheme), [resolvedTheme]);
  const step = INTERVAL_SECONDS[interval];

  const [history, setHistory] = useState<{ bars: Bar[]; error: string | null } | null>(null);
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const drawingKey = `qv.drawings.${symbol}.${interval}`;
  const [drawings, setDrawings] = useState<StoredDrawings>(() => loadDrawings(drawingKey));

  // Load history, then fold live ticks into the latest bar (batched per animation frame).
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    let bars: Bar[] = [];
    let lastDayVolume: number | null = null;
    let frame = 0;

    const flush = () => {
      frame = 0;
      setHistory((h) => ({ bars: bars.slice(), error: h?.error ?? null }));
    };

    const onTick = (tick: Tick) => {
      const t = tick.ts / 1000;
      // Ticks carry cumulative day volume; attribute the delta to the current bar.
      const volDelta = tick.volume != null && lastDayVolume != null ? Math.max(0, tick.volume - lastDayVolume) : 0;
      if (tick.volume != null) lastDayVolume = tick.volume;
      const last = bars.at(-1);
      const lastT = last ? last.date.getTime() / 1000 : null;
      if (lastT != null && t < lastT) return;
      if (lastT != null && t < lastT + step) {
        bars[bars.length - 1] = { ...last!, high: Math.max(last!.high, tick.ltp), low: Math.min(last!.low, tick.ltp), close: tick.ltp, volume: last!.volume + volDelta };
      } else {
        // Keep the history's bar phase (Angel One hourly bars start at :15).
        const start = lastT != null ? lastT + Math.floor((t - lastT) / step) * step : Math.floor((t + IST_OFFSET) / step) * step - IST_OFFSET;
        bars.push({ date: new Date(start * 1000), open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, volume: volDelta });
      }
      if (!frame) frame = requestAnimationFrame(flush);
    };

    let error: string | null = null;
    apiGet<{ candles: Candle[] }>(`/api/market/candles/${symbol}?interval=${interval}&days=${HISTORY_DAYS[interval]}`)
      .then(({ candles }) => {
        bars = candles.map((c) => ({ date: new Date(c.time * 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
      })
      .catch((e: Error) => {
        error = e.message;
      })
      .finally(() => {
        if (cancelled) return;
        setHistory({ bars: bars.slice(), error });
        unsubscribe = marketSocket.subscribe(symbol, onTick);
      });

    return () => {
      cancelled = true;
      unsubscribe();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [symbol, interval, step]);

  const bars = history?.bars;
  const indexed = useMemo(() => (bars ? toIndexed(drawings, bars, step) : { trends: [], fibs: [] }), [drawings, bars, step]);

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
        {bars && bars.length > 0 && size.width > 0 && size.height > 0 && (
          <div className="absolute inset-0">
            <FinancialChart
              width={size.width}
              height={size.height}
              seriesName={`${symbol}-${interval}`}
              bars={bars}
              intraday={interval !== "1d"}
              chartType={chartType}
              indicators={indicators}
              tool={tool}
              trends={indexed.trends}
              fibs={indexed.fibs}
              onTrendsChange={(trends) => bars && saveDrawings({ ...drawings, trends: trends.map((d) => storeTrend(d, bars, step)) })}
              onFibsChange={(fibs) => bars && saveDrawings({ ...drawings, fibs: fibs.map((d) => storeFib(d, bars, step)) })}
              onToolDone={() => setTool("cursor")}
              palette={palette}
              fontFamily={fontFamily}
            />
          </div>
        )}
        {!history && <div className="absolute inset-0 grid place-items-center text-sm text-muted">Loading {symbol}…</div>}
        {history?.error && (
          <div className="absolute left-3 top-3 rounded-md border border-down/40 bg-surface px-3 py-2 text-xs text-down">
            History unavailable: {history.error}. {bars?.length ? "" : "Waiting for live ticks…"}
          </div>
        )}
      </div>
    </div>
  );
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
