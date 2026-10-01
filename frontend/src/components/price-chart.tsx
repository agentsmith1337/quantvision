"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { apiGet, INTERVAL_SECONDS, isAbortError, isTransient, type Candle, type Interval } from "@/lib/api";
import { chartPalette } from "@/lib/chart-theme";
import { marketSocket, type Tick } from "@/lib/market-socket";
import { useElementSize } from "@/lib/use-element-size";
import { BRICK_CHARTS, benchmarkFor, type ChartType, type DrawingTool, type IndicatorId } from "./chart/catalog";
import {
  EMPTY_DRAWINGS,
  drawingCount,
  loadDrawings,
  saveDrawings,
  toIndexed,
  toStored,
  undoLast,
  withAdded,
  type StoredDrawings,
} from "./chart/drawings-store";
import type { Bar, DrawingKind, Drawings, XY } from "./chart/financial-chart";

export type { ChartType, IndicatorId } from "./chart/catalog";

// The chart draws on canvas and touches window at import time; keep it out of the static prerender.
const FinancialChart = dynamic(() => import("./chart/financial-chart"), { ssr: false });

const IST_OFFSET = 19800;
const HISTORY_DAYS: Record<Interval, number> = { "1m": 2, "5m": 10, "15m": 30, "1h": 90, "1d": 730 };

type Props = { symbol: string; interval: Interval; chartType: ChartType; indicators: ReadonlySet<IndicatorId> };

type LoadState = { key: string; status: "retrying" | "ready" | "failed"; attempt: number; error: string | null };
const RETRY_DELAYS = [1000, 2000, 4000];

const historyUrl = (symbol: string, interval: Interval) =>
  `/api/market/candles/${encodeURIComponent(symbol)}?interval=${interval}&days=${HISTORY_DAYS[interval]}`;

export function PriceChart({ symbol, interval, chartType, indicators }: Props) {
  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const { resolvedTheme } = useTheme();
  const palette = useMemo(() => chartPalette(resolvedTheme), [resolvedTheme]);
  const step = INTERVAL_SECONDS[interval];
  const bricks = BRICK_CHARTS.has(chartType);

  const [reloadKey, setReloadKey] = useState(0);
  const loadKey = `${symbol}:${interval}:${reloadKey}`;
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [load, setLoad] = useState<LoadState | null>(null);
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const drawingKey = `qv.drawings.${symbol}.${interval}`;
  const [drawings, setDrawings] = useState<StoredDrawings>(() => loadDrawings(drawingKey));
  const [pendingText, setPendingText] = useState<XY | null>(null);

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
      apiGet<{ candles: Candle[] }>(historyUrl(symbol, interval), { signal: controller.signal })
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

  const benchmark = useBenchmark(indicators.has("compare") && !bricks ? benchmarkFor(symbol) : null, interval);

  const current = load?.key === loadKey ? load : null;
  const shownBars = current?.status === "ready" || current?.status === "failed" ? bars : null;
  const indexed = useMemo(() => (shownBars ? toIndexed(drawings, shownBars, step) : toIndexed(EMPTY_DRAWINGS, [], step)), [drawings, shownBars, step]);

  const update = (next: StoredDrawings) => {
    setDrawings(next);
    saveDrawings(drawingKey, next);
  };
  const onDrawingsChange = <K extends DrawingKind>(kind: K, items: Drawings[K]) => {
    if (shownBars) update({ ...drawings, [kind]: toStored(kind, items, shownBars, step) });
  };
  const addText = (text: string) => {
    if (pendingText && shownBars && text.trim()) {
      const [stored] = toStored("texts", [{ position: pendingText, text: text.trim() }], shownBars, step);
      update(withAdded(drawings, "texts", stored));
    }
    setPendingText(null);
  };

  // Esc drops the active drawing tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTool("cursor");
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fontFamily = typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily;
  const retry = () => setReloadKey((k) => k + 1);
  const count = drawingCount(drawings);

  return (
    <div className="flex h-full w-full">
      <DrawingToolbar
        tool={bricks ? "cursor" : tool}
        disabled={bricks}
        onTool={setTool}
        canUndo={count > 0}
        onUndo={() => update(undoLast(drawings))}
        onClear={() => update(EMPTY_DRAWINGS)}
      />
      <div ref={containerRef} className="relative min-w-0 flex-1">
        {shownBars && shownBars.length > 0 && size.width > 0 && size.height > 0 && (
          <div className="absolute inset-0">
            <ChartErrorBoundary resetKey={`${loadKey}:${chartType}:${[...indicators].sort().join(",")}`} onRetry={retry}>
              <FinancialChart
                width={size.width}
                height={size.height}
                seriesName={`${symbol}-${interval}`}
                bars={shownBars}
                intraday={interval !== "1d"}
                chartType={chartType}
                indicators={indicators}
                benchmark={benchmark}
                tool={bricks ? "cursor" : tool}
                drawings={indexed}
                onDrawingsChange={onDrawingsChange}
                onTextPosition={setPendingText}
                onToolDone={() => setTool("cursor")}
                palette={palette}
                fontFamily={fontFamily}
              />
            </ChartErrorBoundary>
          </div>
        )}
        {tool === "hline" && !bricks && <ToolHint>Click the chart to place a price level. Drag it to adjust; × removes it.</ToolHint>}
        {tool === "text" && !bricks && <ToolHint>Click the chart where the note should go.</ToolHint>}
        {pendingText && <TextPrompt onSubmit={addText} onCancel={() => setPendingText(null)} />}
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

/** Benchmark closes (by bar timestamp) for the Compare pane, or null while off/loading. */
function useBenchmark(symbol: string | null, interval: Interval) {
  const [state, setState] = useState<{ key: string; value: { symbol: string; closes: Map<number, number> } } | null>(null);
  const key = symbol ? `${symbol}:${interval}` : null;

  useEffect(() => {
    if (!symbol || !key) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = (n: number) =>
      apiGet<{ candles: Candle[] }>(historyUrl(symbol, interval), { signal: controller.signal, background: true })
        .then(({ candles }) => setState({ key, value: { symbol, closes: new Map(candles.map((c) => [c.time * 1000, c.close])) } }))
        .catch((e: Error) => {
          if (!controller.signal.aborted && isTransient(e) && n < RETRY_DELAYS.length) timer = setTimeout(() => attempt(n + 1), RETRY_DELAYS[n]);
        });
    attempt(0);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [symbol, interval, key]);

  return state?.key === key ? state.value : null;
}

function ToolHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-surface-2 px-3 py-1 text-xs text-muted shadow">{children}</div>
  );
}

function TextPrompt({ onSubmit, onCancel }: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(text);
      }}
      className="absolute left-1/2 top-12 z-20 flex w-72 -translate-x-1/2 gap-2 rounded-xl border border-border bg-surface p-3 shadow-xl"
    >
      <input
        autoFocus
        value={text}
        maxLength={80}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="Note text"
        className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent"
      />
      <button type="submit" disabled={!text.trim()} className="rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg disabled:opacity-50">
        Add
      </button>
    </form>
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
    // A new symbol/interval/chart type/retry gets a fresh chart.
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
  { id: "hline", label: "Price level", icon: "M3 12h18M17 9l3 3-3 3" },
  { id: "channel", label: "Parallel channel", icon: "M3 16 15 4M9 20 21 8" },
  { id: "stddev", label: "Standard deviation channel", icon: "M3 15 21 7M3 19l18-8M3 11l18-8" },
  { id: "fibonacci", label: "Fibonacci retracement", icon: "M3 4h18M3 9h18M3 13h18M3 17h18M3 21h18" },
  { id: "gann", label: "Gann fan", icon: "M4 20 20 4M4 20l16-8M4 20 12 4M4 20h16" },
  { id: "text", label: "Text note", icon: "M5 5h14M12 5v14M9 19h6" },
];

function DrawingToolbar(props: {
  tool: DrawingTool;
  disabled: boolean;
  onTool: (t: DrawingTool) => void;
  canUndo: boolean;
  onUndo: () => void;
  onClear: () => void;
}) {
  const btn = "grid size-8 place-items-center rounded-md disabled:cursor-not-allowed disabled:opacity-30";
  const icon = (d: string) => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden>
      <path d={d} />
    </svg>
  );
  return (
    <div className="flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          title={props.disabled && t.id !== "cursor" ? `${t.label} (time-based charts only)` : t.label}
          aria-label={t.label}
          aria-pressed={props.tool === t.id}
          disabled={props.disabled && t.id !== "cursor"}
          onClick={() => props.onTool(t.id)}
          className={`${btn} ${props.tool === t.id ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"}`}
        >
          {icon(t.icon)}
        </button>
      ))}
      <div className="my-1 w-5 border-t border-border" />
      <button title="Undo last drawing" aria-label="Undo last drawing" disabled={!props.canUndo} onClick={props.onUndo} className={`${btn} text-muted hover:bg-surface-2 hover:text-fg`}>
        {icon("M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3")}
      </button>
      <button title="Clear all drawings" aria-label="Clear all drawings" disabled={!props.canUndo} onClick={props.onClear} className={`${btn} text-muted hover:bg-surface-2 hover:text-down`}>
        {icon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3")}
      </button>
    </div>
  );
}
