"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { PriceChart, type ChartType, type IndicatorId } from "@/components/price-chart";
import { ChartTypeSelect, IndicatorMenu } from "@/components/chart-controls";
import { OrderTicket } from "@/components/order-ticket";
import { OrdersPanel } from "@/components/orders-panel";
import { type Instrument, type Interval } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useTick } from "@/lib/market-socket";
import { changeColor, formatChange, formatPrice } from "@/lib/format";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "1d"];
function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-lg bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`rounded-md px-2.5 py-1 text-xs ${value === o.id ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TradeDashboard() {
  const symbol = (useSearchParams().get("symbol") ?? "NIFTY").toUpperCase();
  const [interval, setBarInterval] = useState<Interval>("1m");
  const [chartType, setChartType] = useState<ChartType>("candles");
  const [indicators, setIndicators] = useState<ReadonlySet<IndicatorId>>(() => new Set<IndicatorId>(["volume", "ema20", "ema50"]));
  const [action, setAction] = useState<"manual" | "script">("manual");
  const { data: inst, error: instError } = useApi<Instrument>(`/api/market/instruments/${encodeURIComponent(symbol)}`);
  const tick = useTick(symbol);

  return (
    <div className="flex h-full min-h-[640px] gap-4 p-4">
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-3">
          <div>
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg font-semibold">{symbol}</h1>
              <span className="text-xs text-muted">{inst ? `${inst.name} · ${inst.exchange}` : instError ? "Unknown symbol, search for it" : ""}</span>
            </div>
            <div className="flex items-baseline gap-3 font-mono tabular-nums">
              <span className="text-2xl">{formatPrice(tick?.ltp)}</span>
              <span className={`text-sm ${changeColor(tick?.change)}`}>{formatChange(tick?.change, tick?.change_pct)}</span>
            </div>
          </div>
          <dl className="grid grid-cols-4 gap-x-5 text-xs">
            {(["open", "high", "low", "prev_close"] as const).map((k) => (
              <div key={k}>
                <dt className="text-muted">{k === "prev_close" ? "Prev close" : k[0].toUpperCase() + k.slice(1)}</dt>
                <dd className="font-mono tabular-nums">{formatPrice(tick?.[k])}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <IndicatorMenu value={indicators} onChange={setIndicators} chartType={chartType} />
          <div className="ml-auto flex gap-2">
            <Segmented options={INTERVALS.map((i) => ({ id: i, label: i }))} value={interval} onChange={setBarInterval} />
            <ChartTypeSelect value={chartType} onChange={setChartType} />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <PriceChart key={`${symbol}:${interval}`} symbol={symbol} interval={interval} chartType={chartType} indicators={indicators} />
        </div>
      </section>

      <aside className="flex w-[22rem] shrink-0 flex-col gap-4 overflow-y-auto">
        <div className="flex min-h-56 flex-1 flex-col rounded-xl border border-border bg-surface">
          <OrdersPanel symbol={symbol} />
        </div>
        <div className="shrink-0 rounded-xl border border-border bg-surface">
          <div className="flex gap-4 border-b border-border px-4 pt-3">
            {(["manual", "script"] as const).map((id) => (
              <button
                key={id}
                onClick={() => setAction(id)}
                className={`border-b-2 px-1 pb-2 text-sm ${action === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
              >
                {id === "manual" ? "Manual order" : "Script trade"}
              </button>
            ))}
          </div>
          <div className="p-4">
            {action === "manual" ? (
              <OrderTicket key={symbol} symbol={symbol} isIndex={inst?.is_index ?? false} />
            ) : (
              <p className="py-6 text-center text-sm text-muted">The scripting IDE arrives in Phase 3.</p>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
