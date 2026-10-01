"use client";

import Link from "next/link";
import { useState } from "react";
import { IndexCard, WatchlistRow } from "@/components/quotes";
import { SymbolSearch } from "@/components/symbol-search";
import { ApiError, apiPut, type Funds, type Holding, type Position, type TradingMode } from "@/lib/api";
import { changeColor, formatPrice } from "@/lib/format";
import { useTick } from "@/lib/market-socket";
import { useApi } from "@/lib/use-api";

const INDICES = [
  { symbol: "NIFTY", name: "Nifty 50" },
  { symbol: "SENSEX", name: "BSE Sensex" },
  { symbol: "BANKNIFTY", name: "Nifty Bank" },
];

function signed(n: number) {
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}₹${formatPrice(Math.abs(n))}`;
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function HoldingRow({ h }: { h: Holding }) {
  const tick = useTick(h.symbol);
  const ltp = tick?.ltp ?? h.ltp;
  const invested = h.quantity * h.average_price;
  const pnl = ltp != null ? h.quantity * ltp - invested : null;
  const dayChange = tick?.change != null ? tick.change * h.quantity : null;
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-2.5">
        <Link href={`/trade/?symbol=${h.symbol}`} className="font-medium hover:underline">
          {h.symbol}
        </Link>
        <div className="text-xs text-muted">{h.exchange}</div>
      </td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{h.quantity}</td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatPrice(h.average_price)}</td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatPrice(ltp)}</td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatPrice(invested)}</td>
      <td className={`px-4 py-2.5 text-right font-mono tabular-nums ${changeColor(dayChange ?? undefined)}`}>{dayChange != null ? signed(dayChange) : "—"}</td>
      <td className={`px-4 py-2.5 text-right font-mono tabular-nums ${changeColor(pnl ?? undefined)}`}>
        {pnl != null ? signed(pnl) : "—"}
        {pnl != null && invested > 0 && <div className="text-xs">{((pnl / invested) * 100).toFixed(2)}%</div>}
      </td>
    </tr>
  );
}

function PositionRow({ p }: { p: Position }) {
  const tick = useTick(p.symbol);
  const ltp = tick?.ltp ?? p.ltp;
  const avg = p.net_quantity > 0 ? p.buy_average : p.sell_average;
  const unrealised = ltp != null && p.net_quantity !== 0 ? p.net_quantity * (ltp - avg) : 0;
  const total = p.realised_pnl + unrealised;
  return (
    <tr className="border-t border-border">
      <td className="px-4 py-2.5">
        <Link href={`/trade/?symbol=${p.symbol}`} className="font-medium hover:underline">
          {p.symbol}
        </Link>
        <div className="text-xs text-muted">{p.product}</div>
      </td>
      <td className={`px-4 py-2.5 text-right font-mono tabular-nums ${p.net_quantity > 0 ? "text-up" : p.net_quantity < 0 ? "text-down" : "text-muted"}`}>{p.net_quantity}</td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.net_quantity ? formatPrice(avg) : "—"}</td>
      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{formatPrice(ltp)}</td>
      <td className={`px-4 py-2.5 text-right font-mono tabular-nums ${changeColor(total)}`}>{signed(total)}</td>
    </tr>
  );
}

function Watchlist() {
  const watchlist = useApi<string[]>("/api/settings/watchlist");
  const [error, setError] = useState<string | null>(null);
  const save = async (next: string[]) => {
    setError(null);
    try {
      await apiPut("/api/settings/watchlist", next);
      watchlist.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save watchlist");
    }
  };
  const items = watchlist.data ?? [];
  return (
    <Card title="Watchlist">
      <div className="p-3">
        <SymbolSearch placeholder="Add a stock…" onSelect={(i) => !items.includes(i.symbol) && void save([...items, i.symbol])} />
        {error && <p className="mt-2 text-xs text-down">{error}</p>}
      </div>
      <ul className="px-1 pb-2">
        {items.map((s) => (
          <li key={s} className="group flex items-center">
            <div className="min-w-0 flex-1">
              <WatchlistRow symbol={s} />
            </div>
            <button
              onClick={() => void save(items.filter((x) => x !== s))}
              aria-label={`Remove ${s} from watchlist`}
              className="mr-1 rounded px-2 py-1 text-muted opacity-0 hover:text-down group-hover:opacity-100 focus:opacity-100"
            >
              ×
            </button>
          </li>
        ))}
        {items.length === 0 && !watchlist.loading && <li className="px-3 py-2 text-xs text-muted">Search above to add stocks.</li>}
      </ul>
    </Card>
  );
}

export default function PortfolioPage() {
  const holdings = useApi<{ mode: TradingMode; holdings: Holding[] }>("/api/portfolio/holdings", { refreshOnOrders: true, intervalMs: 60_000 });
  const positions = useApi<{ mode: TradingMode; positions: Position[] }>("/api/portfolio/positions", { refreshOnOrders: true, intervalMs: 30_000 });
  const funds = useApi<{ mode: TradingMode; funds: Funds }>("/api/portfolio/funds", { refreshOnOrders: true, intervalMs: 60_000 });
  const mode = holdings.data?.mode ?? funds.data?.mode;

  const th = "px-4 py-2 text-right text-xs font-medium text-muted";
  const invested = (holdings.data?.holdings ?? []).reduce((sum, h) => sum + h.quantity * h.average_price, 0);

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {INDICES.map((i) => (
          <IndexCard key={i.symbol} {...i} />
        ))}
      </div>

      {mode === "paper" && (
        <p className="rounded-lg bg-accent/10 px-4 py-2 text-xs text-accent">
          Showing your <strong>paper</strong> portfolio. Switch to live trading in{" "}
          <Link href="/setup/#preferences" className="underline">
            Settings
          </Link>{" "}
          to see your Angel One holdings.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          ["Available cash", funds.data?.funds.available_cash],
          ["Margin used", funds.data?.funds.used_margin],
          ["Invested (holdings)", holdings.data ? invested : undefined],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-xl border border-border bg-surface p-4">
            <div className="text-xs text-muted">{label}</div>
            <div className="mt-1 font-mono text-xl tabular-nums">{value != null ? `₹${formatPrice(value as number)}` : "—"}</div>
          </div>
        ))}
      </div>
      {funds.error && <p className="text-xs text-down">Funds: {funds.error}</p>}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-4">
          <Card title="Holdings">
            {holdings.error ? (
              <p className="p-4 text-xs text-down">{holdings.error}</p>
            ) : (holdings.data?.holdings.length ?? 0) === 0 ? (
              <p className="p-4 text-xs text-muted">{holdings.loading ? "Loading…" : "No holdings yet."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-muted">Instrument</th>
                      <th className={th}>Qty</th>
                      <th className={th}>Avg price</th>
                      <th className={th}>LTP</th>
                      <th className={th}>Invested</th>
                      <th className={th}>Day&apos;s change</th>
                      <th className={th}>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.data!.holdings.map((h) => (
                      <HoldingRow key={h.symbol} h={h} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Positions (today)">
            {positions.error ? (
              <p className="p-4 text-xs text-down">{positions.error}</p>
            ) : (positions.data?.positions.length ?? 0) === 0 ? (
              <p className="p-4 text-xs text-muted">{positions.loading ? "Loading…" : "No open or closed positions today."}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="px-4 py-2 text-left text-xs font-medium text-muted">Instrument</th>
                      <th className={th}>Net qty</th>
                      <th className={th}>Avg</th>
                      <th className={th}>LTP</th>
                      <th className={th}>P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.data!.positions.map((p) => (
                      <PositionRow key={`${p.symbol}:${p.product}`} p={p} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Watchlist />
      </div>
    </div>
  );
}
