"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PriceChart, type ChartType } from "@/components/price-chart";
import { WatchlistRow } from "@/components/quotes";
import { apiGet, type Instrument, type Interval } from "@/lib/api";
import { useTick } from "@/lib/market-socket";
import { changeColor, formatChange, formatPrice } from "@/lib/format";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "1d"];
const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "bars", label: "Bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
];

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
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const tick = useTick(symbol);

  useEffect(() => {
    apiGet<Instrument[]>("/api/market/instruments").then(setInstruments).catch(() => {});
    apiGet<string[]>("/api/settings/watchlist").then(setWatchlist).catch(() => {});
  }, []);

  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const indices = instruments.filter((i) => i.is_index).map((i) => i.symbol);
  const inst = bySymbol.get(symbol);

  return (
    <div className="flex h-full min-h-[560px] gap-4 p-4">
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-3">
          <div>
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg font-semibold">{symbol}</h1>
              <span className="text-xs text-muted">{inst ? `${inst.name} · ${inst.exchange}` : ""}</span>
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
          <div className="ml-auto flex gap-2">
            <Segmented options={INTERVALS.map((i) => ({ id: i, label: i }))} value={interval} onChange={setBarInterval} />
            <Segmented options={CHART_TYPES} value={chartType} onChange={setChartType} />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <PriceChart key={symbol} symbol={symbol} interval={interval} chartType={chartType} />
        </div>
      </section>

      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto">
        {[
          { title: "Indices", symbols: indices },
          { title: "Watchlist", symbols: watchlist },
        ].map((group) => (
          <div key={group.title} className="rounded-xl border border-border bg-surface p-2">
            <h2 className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted">{group.title}</h2>
            {group.symbols.map((s) => (
              <WatchlistRow key={s} symbol={s} name={bySymbol.get(s)?.name} active={s === symbol} />
            ))}
          </div>
        ))}
        <p className="px-2 text-xs text-muted">Order entry and the script IDE join this dashboard in Phases 2–3.</p>
      </aside>
    </div>
  );
}
