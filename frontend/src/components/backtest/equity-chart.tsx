"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BacktestResult } from "@/lib/api";

type Point = BacktestResult["equity"][number];

const MAIN_H = 220;
const DD_H = 70;
const GAP = 14;
const PAD = { l: 64, r: 12, t: 10, b: 22 };

export const compactInr = (v: number) => {
  const a = Math.abs(v);
  const s = v < 0 ? "-" : "";
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(a >= 1e9 ? 0 : 2)}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(1)}K`;
  return `${s}₹${a.toFixed(0)}`;
};

const dateLabel = (iso: string, intraday: boolean) => {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit", timeZone: "Asia/Kolkata" });
  return intraday ? `${date} ${d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })}` : date;
};

/**
 * Portfolio value over time against NIFTY 50 bought with the same capital, with drawdown below.
 * In "pnl" mode (live runs) the line is P&L in rupees from 0, and drawdown is in rupees too.
 */
export function EquityChart({ points, capital, intraday, mode = "equity" }: { points: Point[]; capital: number; intraday: boolean; mode?: "equity" | "pnl" }) {
  const pnl = mode === "pnl";
  const ddText = (v: number) => (pnl ? compactInr(v) : `%`);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    const n = points.length;
    const values = points.flatMap((p) => (p.benchmark != null ? [p.equity, p.benchmark] : [p.equity])).concat(capital);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    lo -= pad;
    hi += pad;
    const ddMin = Math.min(-0.5, ...points.map((p) => p.drawdown_pct));
    const iw = width - PAD.l - PAD.r;
    const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (MAIN_H - PAD.t);
    const ddTop = MAIN_H + GAP;
    const yd = (v: number) => ddTop + (v / ddMin) * DD_H;
    const path = (get: (p: Point) => number | null) => {
      let d = "";
      points.forEach((p, i) => {
        const v = get(p);
        if (v == null) return;
        d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      });
      return d;
    };
    const ticks = Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * k) / 4);
    const spanDays = n > 1 ? (new Date(points[n - 1].time).getTime() - new Date(points[0].time).getTime()) / 86_400_000 : 0;
    const xticks = n > 1 ? Array.from({ length: Math.min(6, n) }, (_, k) => Math.round((k * (n - 1)) / Math.max(1, Math.min(6, n) - 1))) : [0];
    const dd = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yd(p.drawdown_pct).toFixed(1)}`).join("") + `L${x(n - 1)},${ddTop}L${x(0)},${ddTop}Z`;
    return { x, y, yd, ddTop, ddMin, equity: path((p) => p.equity), bench: path((p) => p.benchmark), dd, ticks, xticks, short: spanDays < 2 };
  }, [points, capital, width]);

  if (!points.length) return null;
  const total = MAIN_H + GAP + DD_H + PAD.b;
  const h = hover != null ? points[hover] : null;
  const up = points.at(-1)!.equity >= capital;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const iw = width - PAD.l - PAD.r;
    const i = Math.round(((px - PAD.l) / iw) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  return (
    <div ref={box} className="relative select-none">
      <div className="mb-1 flex flex-wrap items-center gap-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className={`h-0.5 w-4 ${up ? "bg-up" : "bg-down"}`} /> {pnl ? "P&L after est. charges" : "Strategy"}
        </span>
        {!pnl && (
          <span className="flex items-center gap-1.5">
            <span className="h-0 w-4 border-t border-dashed border-muted" /> NIFTY 50 (same capital)
          </span>
        )}
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 bg-down/30" /> Drawdown
        </span>
      </div>
      <svg width={width} height={total} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label="Equity curve" className="block">
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={width - PAD.r} y1={geo.y(t)} y2={geo.y(t)} className="stroke-border" strokeWidth={0.5} />
            <text x={PAD.l - 6} y={geo.y(t) + 3} textAnchor="end" className="fill-muted text-[10px]">
              {compactInr(t)}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={width - PAD.r} y1={geo.y(capital)} y2={geo.y(capital)} className="stroke-muted" strokeWidth={0.75} strokeDasharray="2 3" />
        {geo.bench && <path d={geo.bench} fill="none" className="stroke-muted" strokeWidth={1.25} strokeDasharray="5 3" />}
        <path d={geo.equity} fill="none" className={up ? "stroke-up" : "stroke-down"} strokeWidth={1.75} strokeLinejoin="round" />

        <text x={PAD.l - 6} y={geo.ddTop + 3} textAnchor="end" className="fill-muted text-[10px]">
          {pnl ? "₹0" : "0%"}
        </text>
        <text x={PAD.l - 6} y={geo.ddTop + DD_H} textAnchor="end" className="fill-muted text-[10px]">
          {ddText(geo.ddMin)}
        </text>
        <line x1={PAD.l} x2={width - PAD.r} y1={geo.ddTop} y2={geo.ddTop} className="stroke-border" strokeWidth={0.5} />
        <path d={geo.dd} className="fill-down/30 stroke-down/60" strokeWidth={0.75} />

        {geo.xticks.map((i) => (
          <text key={i} x={geo.x(i)} y={total - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-muted text-[10px]">
            {geo.short ? new Date(points[i].time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) : dateLabel(points[i].time, false)}
          </text>
        ))}

        {h && hover != null && (
          <g>
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={PAD.t} y2={geo.ddTop + DD_H} className="stroke-fg/40" strokeWidth={0.75} />
            <circle cx={geo.x(hover)} cy={geo.y(h.equity)} r={3} className={up ? "fill-up" : "fill-down"} />
          </g>
        )}
      </svg>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute top-6 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] shadow-lg"
          style={geo.x(hover) > width / 2 ? { right: width - geo.x(hover) + 10 } : { left: geo.x(hover) + 10 }}
        >
          <div className="text-muted">{dateLabel(h.time, intraday)}</div>
          <div className="font-mono">{pnl ? "P&L" : "Strategy"} {compactInr(h.equity)}</div>
          {h.benchmark != null && <div className="font-mono text-muted">NIFTY 50 {compactInr(h.benchmark)}</div>}
          <div className="font-mono text-down">Drawdown {pnl ? compactInr(h.drawdown_pct) : `%`}</div>
        </div>
      )}
    </div>
  );
}
