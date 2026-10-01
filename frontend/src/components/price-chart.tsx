"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { apiGet, INTERVAL_SECONDS, type Candle, type Interval } from "@/lib/api";
import { marketSocket, type Tick } from "@/lib/market-socket";

export type ChartType = "candles" | "bars" | "line" | "area";

// lightweight-charts renders timestamps as UTC; shift so the axis reads in IST.
const IST_OFFSET = 19800;

type Props = { symbol: string; interval: Interval; chartType: ChartType };

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function PriceChart({ symbol, interval, chartType }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Outcome of the history request, keyed so a stale result never shows for a new request.
  const [loaded, setLoaded] = useState<{ key: string; error: string | null } | null>(null);
  const requestKey = `${symbol}:${interval}:${chartType}`;
  const loading = loaded?.key !== requestKey;
  const error = loading ? null : loaded.error;
  const { resolvedTheme } = useTheme();

  // Create/destroy the chart once.
  useEffect(() => {
    const chart = createChart(containerRef.current!, {
      autoSize: true,
      timeScale: { timeVisible: interval !== "1d", secondsVisible: false, rightOffset: 6 },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the active theme palette.
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: {
        background: { type: ColorType.Solid, color: cssVar("--surface") },
        textColor: cssVar("--muted"),
        fontFamily: getComputedStyle(document.body).fontFamily,
      },
      grid: {
        vertLines: { color: cssVar("--surface-2") },
        horzLines: { color: cssVar("--surface-2") },
      },
    });
  }, [resolvedTheme]);

  // Load history, then stream ticks into the latest bar.
  useEffect(() => {
    const chart = chartRef.current!;
    const up = cssVar("--up");
    const down = cssVar("--down");
    const accent = cssVar("--accent");
    chart.applyOptions({ timeScale: { timeVisible: interval !== "1d" } });

    let price: ISeriesApi<SeriesType>;
    if (chartType === "candles") {
      price = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    } else if (chartType === "bars") {
      price = chart.addSeries(BarSeries, { upColor: up, downColor: down });
    } else if (chartType === "line") {
      price = chart.addSeries(LineSeries, { color: accent, lineWidth: 2 });
    } else {
      price = chart.addSeries(AreaSeries, { lineColor: accent, topColor: `${accent}55`, bottomColor: `${accent}05`, lineWidth: 2 });
    }
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const ohlc = chartType === "candles" || chartType === "bars";
    const step = INTERVAL_SECONDS[interval];
    let last: Candle | null = null;
    let lastDayVolume: number | null = null;
    let cancelled = false;
    let unsubscribe = () => {};

    const draw = (bar: Candle) => {
      const time = bar.time as UTCTimestamp;
      price.update(ohlc ? { time, open: bar.open, high: bar.high, low: bar.low, close: bar.close } : { time, value: bar.close });
      volume.update({ time, value: bar.volume, color: bar.close >= bar.open ? `${up}66` : `${down}66` });
    };

    const onTick = (tick: Tick) => {
      const bucket = Math.floor((tick.ts / 1000 + IST_OFFSET) / step) * step;
      // Ticks carry cumulative day volume; attribute the delta to the current bar.
      const volDelta = tick.volume != null && lastDayVolume != null ? Math.max(0, tick.volume - lastDayVolume) : 0;
      if (tick.volume != null) lastDayVolume = tick.volume;
      if (last && bucket < last.time) return;
      if (!last || bucket > last.time) {
        last = { time: bucket, open: tick.ltp, high: tick.ltp, low: tick.ltp, close: tick.ltp, volume: volDelta };
      } else {
        last = { ...last, high: Math.max(last.high, tick.ltp), low: Math.min(last.low, tick.ltp), close: tick.ltp, volume: last.volume + volDelta };
      }
      draw(last);
    };

    const key = `${symbol}:${interval}:${chartType}`;
    let failure: string | null = null;
    const days = { "1m": 2, "5m": 10, "15m": 30, "1h": 90, "1d": 730 }[interval];
    apiGet<{ candles: Candle[] }>(`/api/market/candles/${symbol}?interval=${interval}&days=${days}`)
      .then(({ candles }) => {
        if (cancelled) return;
        const bars = candles.map((c) => ({ ...c, time: c.time + IST_OFFSET }));
        price.setData(
          bars.map((b) => {
            const time = b.time as UTCTimestamp;
            return ohlc ? { time, open: b.open, high: b.high, low: b.low, close: b.close } : { time, value: b.close };
          }),
        );
        volume.setData(bars.map((b) => ({ time: b.time as UTCTimestamp, value: b.volume, color: b.close >= b.open ? `${up}66` : `${down}66` })));
        last = bars.at(-1) ?? null;
        chart.timeScale().fitContent();
        if (bars.length > 150) chart.timeScale().setVisibleLogicalRange({ from: bars.length - 150, to: bars.length + 6 });
      })
      .catch((e: Error) => {
        failure = e.message;
      })
      .finally(() => {
        if (cancelled) return;
        setLoaded({ key, error: failure });
        unsubscribe = marketSocket.subscribe(symbol, onTick);
      });

    return () => {
      cancelled = true;
      unsubscribe();
      // On unmount the chart-creation effect's cleanup runs first and has already
      // removed the chart (and its series); only detach series from a live chart.
      if (chartRef.current === chart) {
        chart.removeSeries(price);
        chart.removeSeries(volume);
      }
    };
  }, [symbol, interval, chartType, resolvedTheme]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {loading && <div className="absolute inset-0 grid place-items-center text-sm text-muted">Loading {symbol}…</div>}
      {error && (
        <div className="absolute left-3 top-3 rounded-md border border-down/40 bg-surface px-3 py-2 text-xs text-down">
          History unavailable: {error}. Showing live ticks only.
        </div>
      )}
    </div>
  );
}
