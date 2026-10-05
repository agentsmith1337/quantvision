"use client";

import { useEffect, useState } from "react";
import type { BacktestPayload, BacktestResult, BacktestSummary } from "@/lib/api";
import { isActive, useBacktests } from "@/lib/backtest-store";
import { useScripts } from "@/lib/scripts-store";
import { EquityChart } from "./equity-chart";
import { FillsTable, inr, pct, StocksTable, SubTabs, tone, TradesTable, when } from "./trade-tables";

/** The Studio's results pane: the backtest on screen, or this script's earlier ones. */
export function BacktestResults({ script }: { script: string }) {
  const { current, history, refreshHistory, open, remove, error } = useBacktests();

  useEffect(() => {
    void refreshHistory(script);
  }, [script, refreshHistory]);

  // Show the latest backtest of this script when nothing (or another script's) is on screen.
  useEffect(() => {
    if ((!current || current.info.script !== script) && history[0]?.script === script) void open(history[0].id);
  }, [script, history, current, open]);

  const shown = current?.info.script === script ? current : null;

  return (
    <div className="flex flex-col">
      {history.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
          <span className="text-muted">Backtest</span>
          <select
            value={shown?.info.id ?? ""}
            onChange={(e) => void open(e.target.value)}
            aria-label="Earlier backtests"
            className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-2 px-2 py-1 outline-none focus:border-accent"
          >
            {!shown && <option value="">Choose…</option>}
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {new Date(h.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })} · {h.interval} · {h.start} → {h.end} ·{" "}
                {h.state === "done" && h.summary ? pct(h.summary.total_return_pct) : h.state}
              </option>
            ))}
          </select>
          {shown && !isActive(shown.info) && (
            <button onClick={() => void remove(shown.info.id)} className="rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-down" title="Delete this backtest">
              Delete
            </button>
          )}
        </div>
      )}
      {error && <p className="px-4 pt-3 text-xs text-down">{error}</p>}
      {shown ? <Shown payload={shown} /> : <Empty />}
    </div>
  );
}

function Empty() {
  return (
    <div className="space-y-3 p-5 text-sm text-muted">
      <p className="font-medium text-fg">No backtests for this script yet.</p>
      <p>
        Choose stocks, a candle size, dates and capital above, then press <span className="font-semibold text-fg">Run simulation</span>. Your on_candle runs unchanged on
        historical candles from Yahoo Finance:
      </p>
      <ul className="list-disc space-y-1 pl-5 text-xs">
        <li>each candle is seen only after it closes; orders fill at the next candle&apos;s open (limit and stop orders when a later candle reaches their price);</li>
        <li>Angel One&apos;s charges and your slippage are deducted from every fill;</li>
        <li>DELIVERY needs cash and holdings; INTRADAY (1h and shorter candles) allows shorting and is squared off at 15:15;</li>
        <li>about 300 candles before the start date are loaded first, so indicators are ready on day one.</li>
      </ul>
      <p className="text-xs">Downloaded candles are cached in Documents/QuantVision/data_cache, so the next backtest on the same stocks starts instantly.</p>
    </div>
  );
}

function Shown({ payload }: { payload: BacktestPayload }) {
  const { info, result, logs, log_count, code } = payload;
  const saved = useScripts((s) => (s.current === info.script ? s.saved : null));
  const intraday = info.interval !== "1d";

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
        <span className="font-mono text-fg">{info.symbols.join(", ")}</span>
        <span>
          {info.interval} · {info.start} → {info.end} · {inr(info.capital, 0)} · {info.slippage_pct}% slippage
          {Object.keys(info.charges).length ? " · custom charges" : ""}
        </span>
        {code && saved != null && code !== saved && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px]">script changed since this backtest</span>}
      </div>

      {isActive(info) && (
        <div className="rounded-lg bg-surface-2 p-3">
          <div className="flex justify-between text-xs">
            <span>{info.message || "Starting…"}</span>
            <span className="font-mono">{Math.round(info.progress * 100)}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(info.progress * 100)}%` }} />
          </div>
        </div>
      )}
      {(info.state === "error" || info.state === "cancelled") && (
        <p className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-xs ${info.state === "error" ? "bg-down/10 text-down" : "bg-surface-2 text-muted"}`}>
          {info.state === "cancelled" ? info.message || "Cancelled" : `Backtest failed: ${info.message}`}
        </p>
      )}

      {result && <Metrics s={result.summary} />}
      {result && result.equity.length > 1 && (
        <div className="rounded-lg border border-border p-3">
          <EquityChart points={result.equity} capital={info.capital} intraday={intraday} />
        </div>
      )}
      <Details result={result} logs={logs} logCount={log_count} intraday={intraday} active={isActive(info)} />
    </div>
  );
}

function Metrics({ s }: { s: BacktestSummary }) {
  const cards: { label: string; value: string; sub?: string; cls?: string; title?: string }[] = [
    { label: "Net P&L", value: inr(s.net_pnl, 0), sub: pct(s.total_return_pct), cls: tone(s.net_pnl) },
    { label: "vs NIFTY 50", value: pct(s.benchmark_return_pct), sub: s.benchmark_return_pct != null ? `${pct(s.total_return_pct - s.benchmark_return_pct)} difference` : undefined, cls: tone(s.benchmark_return_pct) },
    { label: "CAGR", value: pct(s.cagr_pct), cls: tone(s.cagr_pct), title: "Compound annual growth rate (shown for 30+ days)" },
    { label: "Sharpe", value: s.sharpe == null ? "—" : s.sharpe.toFixed(2), sub: s.sortino != null ? `Sortino ${s.sortino.toFixed(2)}` : undefined, title: "Annualised from daily returns, risk-free rate 0%" },
    { label: "Max drawdown", value: pct(s.max_drawdown_pct, false), sub: s.max_drawdown_days ? `${s.max_drawdown_days} days underwater` : undefined, cls: s.max_drawdown_pct < 0 ? "text-down" : "" },
    { label: "Win rate", value: s.win_rate_pct == null ? "—" : `${s.win_rate_pct.toFixed(1)}%`, sub: `${s.trades} closed trade${s.trades === 1 ? "" : "s"}` },
    { label: "Profit factor", value: s.profit_factor == null ? "—" : s.profit_factor.toFixed(2), sub: s.avg_trade_pnl != null ? `${inr(s.avg_trade_pnl, 0)} per trade` : undefined, title: "Gross profit of winners / gross loss of losers (after charges)" },
    {
      label: "Charges",
      value: inr(s.total_charges, 0),
      sub: `${s.fills ?? 0} fills · ${s.exposure_pct ?? 0}% exposed`,
      title: s.charges_breakdown ? Object.entries(s.charges_breakdown).map(([k, v]) => `${k}: ₹${v.toFixed(2)}`).join("\n") : undefined,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-lg bg-surface-2 px-3 py-2" title={c.title}>
          <div className="text-[11px] text-muted">{c.label}</div>
          <div className={`font-mono text-sm font-semibold tabular-nums ${c.cls ?? ""}`}>{c.value}</div>
          {c.sub && <div className="truncate text-[10px] text-muted">{c.sub}</div>}
        </div>
      ))}
    </div>
  );
}

type Tab = "trades" | "fills" | "stocks" | "logs" | "notes";

function Details({ result, logs, logCount, intraday, active }: { result: BacktestResult | null; logs: BacktestPayload["logs"]; logCount: number; intraday: boolean; active: boolean }) {
  const [tab, setTab] = useState<Tab | null>(null);
  const shown: Tab = tab ?? (result ? "trades" : "logs");
  const tabs: [Tab, string][] = result
    ? [
        ["trades", `Trades (${result.trades.length})`],
        ["fills", `Executions (${result.summary.fills ?? result.fills.length})`],
        ["stocks", "By stock"],
        ["logs", `Logs (${logCount})`],
        ...(result.warnings.length ? ([["notes", `Notes (${result.warnings.length})`]] as [Tab, string][]) : []),
      ]
    : [["logs", `Logs (${logCount})`]];

  return (
    <div className="rounded-lg border border-border">
      <SubTabs tabs={tabs} value={shown} onChange={setTab} />
      <div className="overflow-x-auto text-[11px]">
        {shown === "trades" && result && <TradesTable trades={result.trades} intraday={intraday} empty="No trades. The script never completed a buy and sell." />}
        {shown === "fills" && result && <FillsTable fills={result.fills} intraday={intraday} truncated={result.fills_truncated} />}
        {shown === "stocks" && result && <StocksTable rows={result.per_symbol} />}
        {shown === "logs" && (
          <div className="max-h-96 overflow-auto bg-bg px-3 py-2 font-mono leading-relaxed">
            {logs.length === 0 && <div className="text-muted">{active ? "Waiting for output…" : "No log output."}</div>}
            {logs.map((l) => (
              <div key={l.n} className={`whitespace-pre-wrap ${l.level === "error" ? "text-down" : l.level === "warning" ? "text-amber-500" : ""}`}>
                {l.time && <span className="mr-2 text-muted">{when(l.time, intraday)}</span>}
                {l.text}
              </div>
            ))}
            {logCount > logs.length && !active && <div className="text-muted">Showing the last {logs.length.toLocaleString("en-IN")} of {logCount.toLocaleString("en-IN")} lines.</div>}
          </div>
        )}
        {shown === "notes" && result && (
          <ul className="list-disc space-y-1 py-2 pl-7 pr-3 text-muted">
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}