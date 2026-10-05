"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BacktestFill, RunBar, RunPerformance } from "@/lib/api";

const H = 260;
const PAD = { l: 8, r: 64, t: 12, b: 22 };
const WINDOWS = [60, 120, 300] as const;

const fmtTime = (epoch: number, daily: boolean) =>
  new Date(epoch * 1000).toLocaleString("en-IN", daily ? { day: "2-digit", month: "short", timeZone: "Asia/Kolkata" } : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

/** Index of the candle a fill happened in: the last candle that started at or before it. */
function barIndex(bars: RunBar[], epoch: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= epoch) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The run's candles for one stock, with its buys (▲) and sells (▼), average price and LTP. */
export function RunChart({ chart, daily, intervalSec }: { chart: RunPerformance["chart"]; daily: boolean; intervalSec: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [windowSize, setWindowSize] = useState<number>(120);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view = useMemo(() => {
    const all = chart.bars;
    const start = Math.max(0, all.length - windowSize);
    const bars = all.slice(start);
    const marks = new Map<number, BacktestFill[]>();
    // Fills after the last closed candle (its candle hasn't closed yet) get a slot of their own on the right.
    const lastEnd = all.length ? all[all.length - 1].time + intervalSec : 0;
    const pending: BacktestFill[] = [];
    for (const f of chart.fills) {
      const epoch = Date.parse(f.time) / 1000;
      if (all.length && epoch >= lastEnd) {
        pending.push(f);
        continue;
      }
      const i = barIndex(all, epoch) - start;
      if (i >= 0 && i < bars.length) marks.set(i, [...(marks.get(i) ?? []), f]);
    }
    const prices = [...bars.flatMap((b) => [b.high, b.low]), ...pending.map((f) => f.price)];
    const lo0 = prices.length ? Math.min(...prices) : 0;
    const hi0 = prices.length ? Math.max(...prices) : 1;
    const extra = [chart.position?.average_price, chart.ltp].filter((v): v is number => v != null && v > lo0 * 0.85 && v < hi0 * 1.15);
    let lo = Math.min(lo0, ...extra);
    let hi = Math.max(hi0, ...extra);
    const pad = (hi - lo) * 0.08 || hi * 0.005 || 1;
    lo -= pad;
    hi += pad;
    const iw = width - PAD.l - PAD.r;
    const slots = bars.length + (pending.length ? 1 : 0);
    const step = slots ? iw / slots : iw;
    const x = (i: number) => PAD.l + step * (i + 0.5);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const ticks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * (k + 0.5)) / 5);
    const xticks = bars.length ? Array.from({ length: Math.min(6, bars.length) }, (_, k) => Math.round((k * (bars.length - 1)) / Math.max(1, Math.min(6, bars.length) - 1))) : [];
    return { bars, marks, pending, x, y, step, ticks, xticks, total: all.length };
  }, [chart, windowSize, width, intervalSec]);

  if (!chart.bars.length) {
    return <p className="py-8 text-center text-xs text-muted">No candles for {chart.symbol} yet. They appear as the run receives them.</p>;
  }

  const { bars, marks, pending, x, y, step } = view;
  const candles = step >= 3;
  const body = Math.max(1, Math.min(12, step * 0.6));
  const h = hover != null ? bars[hover] : null;
  const pos = chart.position;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setHover(Math.min(bars.length - 1, Math.max(0, Math.floor((px - PAD.l) / step))));
  };

  const priceLine = (v: number, cls: string, label: string, dashed = true) => (
    <g>
      <line x1={PAD.l} x2={width - PAD.r} y1={y(v)} y2={y(v)} className={cls} strokeWidth={1} strokeDasharray={dashed ? "4 3" : undefined} />
      <rect x={width - PAD.r + 2} y={y(v) - 7} width={PAD.r - 4} height={14} rx={2} className={cls.replace("stroke-", "fill-")} />
      <text x={width - PAD.r + 5} y={y(v) + 3} className="fill-white text-[9px] font-semibold">
        {label}
      </text>
    </g>
  );

  return (
    <div ref={box} className="relative select-none">
      <div className="mb-1 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span className="text-up">▲</span> buy
        </span>
        <span className="flex items-center gap-1">
          <span className="text-down">▼</span> sell
        </span>
        {pos && (
          <span>
            Holding <span className="font-mono text-fg">{pos.quantity}</span> {pos.product === "INTRADAY" ? "MIS" : "CNC"} @ <span className="font-mono text-fg">{pos.average_price.toFixed(2)}</span>
          </span>
        )}
        <span className="ml-auto flex rounded-md bg-surface-2 p-0.5">
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setWindowSize(w)} className={`rounded px-1.5 text-[10px] ${windowSize === w ? "bg-surface font-semibold text-fg" : "hover:text-fg"}`}>
              {w}
            </button>
          ))}
        </span>
      </div>
      <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${chart.symbol} price with trades`} className="block">
        {view.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} className="stroke-border" strokeWidth={0.5} />
            <text x={width - PAD.r + 5} y={y(t) + 3} className="fill-muted text-[10px]">
              {t.toFixed(t >= 1000 ? 0 : 2)}
            </text>
          </g>
        ))}
        {candles ? (
          bars.map((b, i) => {
            const up = b.close >= b.open;
            return (
              <g key={b.time} className={up ? "fill-up stroke-up" : "fill-down stroke-down"}>
                <line x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} strokeWidth={1} />
                <rect x={x(i) - body / 2} y={y(Math.max(b.open, b.close))} width={body} height={Math.max(1, Math.abs(y(b.open) - y(b.close)))} />
              </g>
            );
          })
        ) : (
          <path d={bars.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join("")} fill="none" className="stroke-accent" strokeWidth={1.25} />
        )}
        {pos && priceLine(pos.average_price, "stroke-accent", `avg ${pos.average_price.toFixed(pos.average_price >= 1000 ? 0 : 1)}`)}
        {chart.ltp != null && priceLine(chart.ltp, "stroke-muted", chart.ltp.toFixed(chart.ltp >= 1000 ? 0 : 2), false)}
        {[...marks.entries()].map(([i, fills]) =>
          fills.map((f, k) => {
            const buy = f.side === "BUY";
            const b = bars[i];
            const cy = buy ? y(b.low) + 10 + k * 11 : y(b.high) - 10 - k * 11;
            return (
              <text key={`${i}-${k}`} x={x(i)} y={cy + 4} textAnchor="middle" className={`${buy ? "fill-up" : "fill-down"} text-[11px] font-bold`}>
                {buy ? "▲" : "▼"}
              </text>
            );
          }),
        )}
        {pending.map((f, k) => (
          <text key={`p-${k}`} x={x(bars.length)} y={y(f.price) + 4} textAnchor="middle" className={` text-[11px] font-bold`}>
            <title>{`  @  (candle still open)`}</title>
            {f.side === "BUY" ? "▲" : "▼"}
          </text>
        ))}
        {view.xticks.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle"} className="fill-muted text-[10px]">
            {fmtTime(bars[i].time, daily)}
          </text>
        ))}
        {h && hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="stroke-fg/40" strokeWidth={0.75} />}
      </svg>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute top-6 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-lg"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}
        >
          <div className="text-muted">{new Date(h.time * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })}</div>
          <div className="font-mono">
            O {h.open.toFixed(2)} H {h.high.toFixed(2)}
          </div>
          <div className="font-mono">
            L {h.low.toFixed(2)} C {h.close.toFixed(2)}
          </div>
          {(marks.get(hover) ?? []).map((f, k) => (
            <div key={k} className={`font-mono font-semibold ${f.side === "BUY" ? "text-up" : "text-down"}`}>
              {f.side} {f.quantity} @ {f.price.toFixed(2)}
            </div>
          ))}
        </div>
      )}
      {view.total > bars.length && <p className="text-[10px] text-muted">Last {bars.length} of {view.total} candles.</p>}
    </div>
  );
}
