"use client";

import Link from "next/link";
import { IndexCard } from "@/components/quotes";
import { useFeedStatus } from "@/lib/market-socket";

const INDICES = [
  { symbol: "NIFTY", name: "Nifty 50" },
  { symbol: "SENSEX", name: "BSE Sensex" },
  { symbol: "BANKNIFTY", name: "Nifty Bank" },
];

const FEATURES = [
  { title: "Live market data", body: "Angel One SmartAPI ticks streamed into interactive charts with indicators (EMA, Bollinger, RSI, MACD) and drawing tools.", phase: 1 },
  { title: "Portfolio & manual trading", body: "Holdings, positions and P&L in real time, with an order ticket for manual trades.", phase: 2 },
  { title: "Algo IDE", body: "Write Python strategies in a Monaco editor with built-in indicators and a safe trading SDK.", phase: 3 },
  { title: "Backtesting studio", body: "Run strategies against cached historical data with Backtrader and review the equity curve.", phase: 4 },
  { title: "Local execution", body: "Everything runs on your machine; your keys and scripts never leave it.", phase: 1 },
  { title: "AI copilot & news analyst", body: "LLM help for writing strategies and sentiment signals from financial news.", phase: 6 },
];

const QUICK_START = [
  <>
    Copy <code>backend/.env.example</code> to <code>backend/.env</code> and fill in your Angel One API key, client code, MPIN and TOTP secret.
  </>,
  <>
    Run <code>python run.py</code> from the project folder. Without credentials the app uses simulated prices.
  </>,
  <>
    Open the <Link href="/trade/?symbol=NIFTY" className="text-accent underline-offset-2 hover:underline">Trading Dashboard</Link> to watch live candles.
  </>,
];

function HealthPanel() {
  const status = useFeedStatus();
  const rows: [string, string, boolean][] = [
    ["Local engine", status ? "Running" : "Unreachable", !!status],
    ["Market data", status ? (status.mode === "angelone" ? "Angel One" : "Simulated") : "—", status?.mode === "angelone"],
    ["Feed connection", status?.state ?? "—", status?.state === "connected"],
  ];
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="font-display text-lg font-semibold">System health</h2>
      <dl className="mt-3 space-y-2 text-sm">
        {rows.map(([label, value, ok]) => (
          <div key={label} className="flex justify-between">
            <dt className="text-muted">{label}</dt>
            <dd className={`capitalize ${ok ? "text-up" : "text-fg"}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {status?.message && <p className="mt-3 text-xs text-muted">{status.message}</p>}
    </div>
  );
}

export default function Home() {
  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6 md:p-10">
      <section>
        <h1 className="font-display text-4xl font-semibold tracking-tight">QuantVision</h1>
        <p className="mt-2 max-w-2xl text-muted">
          A local algorithmic trading engine for Angel One. Watch markets live, build and backtest Python strategies, and run them from your own machine.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {INDICES.map((i) => (
          <IndexCard key={i.symbol} {...i} />
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-display font-semibold">{f.title}</h3>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${f.phase === 1 ? "bg-up/15 text-up" : "bg-surface-2 text-muted"}`}>
                  {f.phase === 1 ? "Available" : `Phase ${f.phase}`}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted">{f.body}</p>
            </div>
          ))}
        </div>
        <div className="space-y-4">
          <HealthPanel />
          <div className="rounded-xl border border-border bg-surface p-5">
            <h2 className="font-display text-lg font-semibold">Quick start</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted [&_code]:rounded [&_code]:bg-surface-2 [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_code]:text-fg">
              {QUICK_START.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}
