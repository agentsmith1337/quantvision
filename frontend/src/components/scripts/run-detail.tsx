"use client";

import { useEffect, useRef, useState } from "react";
import { EquityChart } from "@/components/backtest/equity-chart";
import { FillsTable, inr, StocksTable, SubTabs, tone, TradesTable } from "@/components/backtest/trade-tables";
import { apiGet, INTERVAL_SECONDS, type RunInfo, type RunPerformance } from "@/lib/api";
import { useScripts } from "@/lib/scripts-store";
import { RunChart } from "./run-chart";

const POLL_MS = 2000;
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

type Tab = "positions" | "trades" | "fills" | "stocks" | "logs";

/** One run's results so far: metrics, P&L curve, price chart with its trades, tables and log. */
export function RunDetail({ run }: { run: RunInfo }) {
  const [perf, setPerf] = useState<RunPerformance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);

  // Live while the run is active (plus whenever its counters move), once more when it ends.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
        const p = await apiGet<RunPerformance>(`/api/runs/${run.id}/performance${q}`);
        if (!cancelled) {
          setPerf(p);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled && run.active) timer = setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [run.id, run.active, run.orders, run.candles, symbol]);

  const intraday = run.interval !== "1d";
  const s = perf?.summary;
  const shown: Tab = tab ?? (s && s.fills > 0 ? (s.open_positions ? "positions" : "trades") : "logs");

  const cards: { label: string; value: string; sub?: string; cls?: string; title?: string }[] = s
    ? [
        { label: "Net P&L", value: inr(s.net_pnl, 0), sub: "after est. charges", cls: tone(s.net_pnl) },
        { label: "Realised", value: inr(s.realized, 0), sub: `${s.trades} closed trade${s.trades === 1 ? "" : "s"}`, cls: tone(s.realized) },
        { label: "Unrealised", value: inr(s.unrealized, 0), sub: `${s.open_positions} open position${s.open_positions === 1 ? "" : "s"}`, cls: tone(s.unrealized) },
        { label: "Est. charges", value: inr(s.charges, 0), sub: `on ${inr(s.turnover, 0)} turnover`, title: "Estimated with Angel One's tariff; the contract note has the exact figures" },
        { label: "Win rate", value: s.win_rate_pct == null ? "—" : `${s.win_rate_pct.toFixed(1)}%`, sub: s.profit_factor != null ? `profit factor ${s.profit_factor.toFixed(2)}` : undefined },
        { label: "Max drawdown", value: inr(s.max_drawdown, 0), sub: "from the run's best P&L", cls: s.max_drawdown < 0 ? "text-down" : "" },
        { label: "Orders", value: String(s.orders), sub: `${s.fills} fills · ${s.rejected} rejected${s.cancelled ? ` · ${s.cancelled} cancelled` : ""}`, cls: s.rejected ? "text-down" : "" },
        { label: "Best / worst", value: s.best_trade == null ? "—" : `${inr(s.best_trade, 0)}`, sub: s.worst_trade == null ? undefined : `worst ${inr(s.worst_trade, 0)}` },
      ]
    : [];

  const tabs: [Tab, string][] = [
    ["positions", `Positions (${perf?.positions.length ?? 0})`],
    ["trades", `Trades (${perf?.trades.length ?? 0})`],
    ["fills", `Executions (${s?.fills ?? 0})`],
    ["stocks", "By stock"],
    ["logs", "Log"],
  ];
  const traded = new Set(perf?.per_symbol.map((p) => p.symbol));

  return (
    <div className="space-y-3 p-3">
      {error && <p className="text-xs text-down">{error}</p>}
      {!perf && !error && <p className="text-xs text-muted">Loading…</p>}
      {perf && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {cards.map((c) => (
              <div key={c.label} className="rounded-lg bg-surface-2 px-3 py-2" title={c.title}>
                <div className="text-[11px] text-muted">{c.label}</div>
                <div className={`font-mono text-sm font-semibold tabular-nums ${c.cls ?? ""}`}>{c.value}</div>
                {c.sub && <div className="truncate text-[10px] text-muted">{c.sub}</div>}
              </div>
            ))}
          </div>

          <div className="rounded-lg border border-border p-3">
            {perf.curve.length > 1 ? (
              <EquityChart
                mode="pnl"
                capital={0}
                intraday={intraday}
                points={perf.curve.map((p) => ({ time: p.time, equity: p.pnl, benchmark: null, drawdown_pct: p.drawdown }))}
              />
            ) : (
              <p className="py-4 text-center text-xs text-muted">The P&L curve starts with the run&apos;s first candle or fill.</p>
            )}
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap gap-1">
              {perf.symbols.map((sym) => (
                <button
                  key={sym}
                  onClick={() => setSymbol(sym)}
                  className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${perf.chart.symbol === sym ? "bg-accent text-accent-fg" : "bg-surface-2 hover:text-fg"} ${traded.has(sym) ? "font-semibold" : "text-muted"}`}
                  title={traded.has(sym) ? "Traded by this run" : undefined}
                >
                  {sym}
                  {traded.has(sym) && perf.chart.symbol !== sym ? " •" : ""}
                </button>
              ))}
            </div>
            <RunChart chart={perf.chart} daily={!intraday} intervalSec={INTERVAL_SECONDS[run.interval]} />
          </div>
        </>
      )}

      <div className="rounded-lg border border-border">
        <SubTabs tabs={tabs} value={shown} onChange={setTab} />
        <div className="overflow-x-auto text-[11px]">
          {shown === "positions" && perf && <PositionsTable rows={perf.positions} />}
          {shown === "trades" && perf && <TradesTable trades={perf.trades} intraday={intraday} empty="No trades yet." />}
          {shown === "fills" && perf && <FillsTable fills={perf.fills} intraday={intraday} truncated={perf.fills_truncated} />}
          {shown === "stocks" && perf && <StocksTable rows={perf.per_symbol} />}
          {shown === "logs" && <RunLog runId={run.id} />}
        </div>
      </div>
      {perf && <p className="text-[10px] text-muted">Only orders placed by this run are counted; positions held before it started aren&apos;t included. Charges are estimates.</p>}
    </div>
  );
}

function PositionsTable({ rows }: { rows: RunPerformance["positions"] }) {
  const th = "px-2 py-1.5 text-left font-medium text-muted";
  const td = "px-2 py-1 font-mono tabular-nums text-right";
  return (
    <table className="w-full">
      <thead>
        <tr className="border-b border-border">
          <th className={th}>Stock</th>
          <th className={`${th} text-right`}>Qty</th>
          <th className={`${th} text-right`}>Avg price</th>
          <th className={`${th} text-right`}>LTP</th>
          <th className={`${th} text-right`}>Unrealised</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={5} className="px-2 py-3 text-muted">
              No open positions.
            </td>
          </tr>
        )}
        {rows.map((p) => (
          <tr key={`${p.symbol}-${p.product}`} className="border-b border-border/50 last:border-0">
            <td className="px-2 py-1">
              <span className="font-mono">{p.symbol}</span> <span className="text-[10px] text-muted">{p.product === "INTRADAY" ? "MIS" : "CNC"}</span>
            </td>
            <td className={`${td} ${p.quantity < 0 ? "text-down" : ""}`}>{p.quantity}</td>
            <td className={td}>{p.average_price.toFixed(2)}</td>
            <td className={td}>{p.ltp == null ? "—" : p.ltp.toFixed(2)}</td>
            <td className={`${td} ${tone(p.unrealized)}`}>{inr(p.unrealized)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The run's live log, following new lines unless scrolled up. */
function RunLog({ runId }: { runId: string }) {
  const lines = useScripts((s) => s.logs[runId]) ?? [];
  const loadLogs = useScripts((s) => s.loadLogs);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    void loadLogs(runId);
  }, [runId, loadLogs]);

  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="max-h-80 overflow-auto bg-bg px-3 py-2 font-mono leading-relaxed"
      aria-live="polite"
    >
      {lines.map((l) => (
        <div key={l.seq} className={`whitespace-pre-wrap break-words ${l.level === "error" ? "text-down" : l.level === "warning" ? "text-warn" : "text-fg"}`}>
          <span className="mr-2 text-muted">{timeFmt.format(new Date(l.ts * 1000))}</span>
          {l.text}
        </div>
      ))}
      {lines.length === 0 && <span className="text-muted">No log output yet.</span>}
    </div>
  );
}
