"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Group, Panel, Separator, useDefaultLayout, type LayoutStorage } from "react-resizable-panels";
import { PriceChart, type ChartType, type IndicatorId } from "@/components/price-chart";
import { ChartTypeSelect, IndicatorMenu } from "@/components/chart-controls";
import { AnalysisPanel } from "@/components/analysis-panel";
import { OrderTicket } from "@/components/order-ticket";
import { QuickScript } from "@/components/scripts/quick-script";
import { OrdersPanel } from "@/components/orders-panel";
import { type Instrument, type Interval } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { useTick } from "@/lib/market-socket";
import { changeColor, formatChange, formatPrice } from "@/lib/format";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "1d"];

// The split position is remembered per browser; storage can be unavailable (private mode, prerender).
const layoutStorage: LayoutStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* not remembered */
    }
  },
};

// Panels grow with their content (the page scrolls) instead of clipping it.
const naturalHeight = { height: "auto", overflow: "visible" } as const;
const panelContent = { overflow: "visible", maxHeight: "none" } as const;

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
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "qv-trade-split", panelIds: ["chart", "side"], storage: layoutStorage, onlySaveAfterUserInteractions: true });

  return (
    <Group id="qv-trade-split" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} className="p-4" style={naturalHeight}>
      <Panel id="chart" minSize="40%" className="flex min-w-0 flex-col gap-4" style={panelContent}>
        {/* The chart fills most of the screen; the analysis panel below it grows with its content. */}
        <section className="flex h-[calc(100dvh-3.5rem-2rem-10rem)] min-h-[480px] flex-col rounded-xl border border-border bg-surface">
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
        <section className="rounded-xl border border-border bg-surface">
          <AnalysisPanel symbol={symbol} interval={interval} />
        </section>
      </Panel>

      <Separator
        aria-label="Resize chart and orders"
        title="Drag to resize · double-click to reset"
        className="group mx-1 flex w-2 shrink-0 cursor-col-resize justify-center outline-none"
      >
        <span className="sticky top-[40vh] h-12 w-1 self-start rounded-full bg-border transition-colors group-data-[separator=active]:bg-accent group-data-[separator=focus]:bg-accent group-data-[separator=hover]:bg-accent" />
      </Separator>

      <Panel id="side" defaultSize={352} minSize={300} maxSize="55%" style={panelContent}>
        {/* Stays in view while the page scrolls past the analysis panel. */}
        <aside className="sticky top-0 flex max-h-[calc(100dvh-3.5rem-2rem)] flex-col gap-4 overflow-y-auto">
          <div className="flex min-h-56 flex-col rounded-xl border border-border bg-surface">
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
              {action === "manual" ? <OrderTicket key={symbol} symbol={symbol} isIndex={inst?.is_index ?? false} /> : <QuickScript symbol={symbol} />}
            </div>
          </div>
        </aside>
      </Panel>
    </Group>
  );
}
