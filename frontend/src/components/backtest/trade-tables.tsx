"use client";

// Tables shared by backtest results and live runs: round-trip trades, executions, per-stock results.

import type { BacktestFill, BacktestTrade } from "@/lib/api";

export const inr = (v: number | null | undefined, digits = 2) =>
  v == null ? "—" : `${v < 0 ? "-" : ""}₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const pct = (v: number | null | undefined, signed = true) => (v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(2)}%`);
export const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "text-up" : "text-down");
export const when = (iso: string | null, intraday: boolean) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
        ...(intraday ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
        timeZone: "Asia/Kolkata",
      })
    : "—";

export type StockRow = { symbol: string; trades: number; net_pnl: number; win_rate_pct: number | null; open_pnl: number };

const th = "px-2 py-1.5 text-left font-medium text-muted";
const td = "px-2 py-1 font-mono tabular-nums";

function Empty({ cols, text }: { cols: number; text: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-2 py-3 text-muted">
        {text}
      </td>
    </tr>
  );
}

export function TradesTable({ trades, intraday, empty = "No trades yet." }: { trades: BacktestTrade[]; intraday: boolean; empty?: string }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border">
          <th className={th}>Stock</th>
          <th className={th}>Side</th>
          <th className={`${th} text-right`}>Qty</th>
          <th className={th}>Entry</th>
          <th className={th}>Exit</th>
          <th className={`${th} text-right`}>Charges</th>
          <th className={`${th} text-right`}>Net P&L</th>
        </tr>
      </thead>
      <tbody>
        {trades.length === 0 && <Empty cols={7} text={empty} />}
        {trades.map((t, i) => (
          <tr key={i} className="border-b border-border/50 last:border-0">
            <td className="px-2 py-1">
              <span className="font-mono">{t.symbol}</span>
              {t.product === "INTRADAY" && <span className="ml-1 text-[10px] text-muted">MIS</span>}
              {t.open && <span className="ml-1 rounded bg-accent/15 px-1 text-[10px] text-accent">open</span>}
            </td>
            <td className={`px-2 py-1 ${t.direction === "long" ? "text-up" : "text-down"}`}>{t.direction}</td>
            <td className={`${td} text-right`}>{t.quantity}</td>
            <td className={td}>
              {when(t.entry_time, intraday)} <span className="text-muted">@ {t.entry_price.toFixed(2)}</span>
            </td>
            <td className={td}>
              {t.open ? <span className="text-muted">now</span> : when(t.exit_time, intraday)} <span className="text-muted">@ {t.exit_price.toFixed(2)}</span>
            </td>
            <td className={`${td} text-right text-muted`}>{t.charges.toFixed(2)}</td>
            <td className={`${td} text-right ${tone(t.net_pnl)}`}>
              {inr(t.net_pnl)} <span className="text-[10px]">({pct(t.return_pct)})</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FillsTable({ fills, intraday, truncated }: { fills: BacktestFill[]; intraday: boolean; truncated?: boolean }) {
  return (
    <>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            <th className={th}>Filled</th>
            <th className={th}>Stock</th>
            <th className={th}>Side</th>
            <th className={th}>Type</th>
            <th className={`${th} text-right`}>Qty</th>
            <th className={`${th} text-right`}>Price</th>
            <th className={`${th} text-right`}>Value</th>
            <th className={`${th} text-right`}>Charges</th>
          </tr>
        </thead>
        <tbody>
          {fills.length === 0 && <Empty cols={8} text="Nothing filled yet." />}
          {fills.map((f, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0">
              <td className={td} title={f.placed ? `Placed ${when(f.placed, true)}` : undefined}>
                {when(f.time, intraday)}
              </td>
              <td className="px-2 py-1 font-mono">{f.symbol}</td>
              <td className={`px-2 py-1 font-semibold ${f.side === "BUY" ? "text-up" : "text-down"}`}>{f.side}</td>
              <td className="px-2 py-1 text-muted">
                {f.order_type} · {f.product === "INTRADAY" ? "MIS" : "CNC"}
                {f.auto && " · square-off"}
              </td>
              <td className={`${td} text-right`}>{f.quantity}</td>
              <td className={`${td} text-right`}>{f.price.toFixed(2)}</td>
              <td className={`${td} text-right`}>{inr(f.value, 0)}</td>
              <td className={`${td} text-right text-muted`}>{f.charges.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <p className="px-2 py-2 text-muted">Only the first {fills.length.toLocaleString("en-IN")} executions are listed.</p>}
    </>
  );
}

export function StocksTable({ rows }: { rows: StockRow[] }) {
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border">
          <th className={th}>Stock</th>
          <th className={`${th} text-right`}>Closed trades</th>
          <th className={`${th} text-right`}>Win rate</th>
          <th className={`${th} text-right`}>Net P&L</th>
          <th className={`${th} text-right`}>Open P&L</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && <Empty cols={5} text="No stock was traded." />}
        {rows.map((p) => (
          <tr key={p.symbol} className="border-b border-border/50 last:border-0">
            <td className="px-2 py-1 font-mono">{p.symbol}</td>
            <td className={`${td} text-right`}>{p.trades}</td>
            <td className={`${td} text-right`}>{p.win_rate_pct == null ? "—" : `${p.win_rate_pct.toFixed(1)}%`}</td>
            <td className={`${td} text-right ${tone(p.net_pnl)}`}>{inr(p.net_pnl)}</td>
            <td className={`${td} text-right ${tone(p.open_pnl)}`}>{p.open_pnl ? inr(p.open_pnl) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Underlined tab strip used under results. */
export function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-4 overflow-x-auto border-b border-border px-3 pt-2">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`shrink-0 border-b-2 px-1 pb-1.5 text-xs ${value === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
