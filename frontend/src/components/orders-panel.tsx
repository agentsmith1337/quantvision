"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, apiDelete, apiPost, type Order, type Trade } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { useScripts } from "@/lib/scripts-store";
import { useApi } from "@/lib/use-api";
import { ConfirmDialog } from "./confirm-dialog";

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
};

function ScriptBadge({ tag }: { tag: string }) {
  const script = useScripts((st) => st.runs.find((r) => r.tag === tag)?.script);
  return (
    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted" title={script ? `Placed by ${script}` : "Placed by a script"}>
      script{script ? `: ${script.replace(/\.py$/, "")}` : ""}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone =
    status === "complete" ? "bg-up/15 text-up" : status === "rejected" ? "bg-down/15 text-down" : status === "cancelled" ? "bg-surface-2 text-muted" : "bg-accent/15 text-accent";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${tone}`}>{status}</span>;
}

/** Today's orders and executed trades for the active broker (paper or live). */
export function OrdersPanel({ symbol }: { symbol?: string }) {
  const [tab, setTab] = useState<"orders" | "trades">("orders");
  const [onlySymbol, setOnlySymbol] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const orders = useApi<{ orders: Order[] }>("/api/orders", { refreshOnOrders: true, intervalMs: 15_000 });
  const trades = useApi<{ trades: Trade[] }>(tab === "trades" ? "/api/orders/trades" : null, { refreshOnOrders: true, intervalMs: 15_000 });

  const filter = <T extends { symbol: string }>(rows: T[] | undefined) => (rows ?? []).filter((r) => !onlySymbol || !symbol || r.symbol === symbol);
  const orderRows = filter(orders.data?.orders);
  const tradeRows = filter(trades.data?.trades);
  const openCount = (orders.data?.orders ?? []).filter((o) => o.is_open).length;

  const cancel = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await apiDelete(`/api/orders/${id}`);
      orders.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Cancel failed");
    } finally {
      setBusy(null);
    }
  };

  const cancelAll = async () => {
    setBusy("all");
    setError(null);
    try {
      const r = await apiPost<{ cancelled: string[]; failed: { order_id: string; error: string }[] }>("/api/orders/cancel-all");
      if (r.failed.length) setError(`${r.failed.length} order(s) couldn't be cancelled: ${r.failed[0].error}`);
      orders.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Cancel all failed");
    } finally {
      setBusy(null);
      setConfirmAll(false);
    }
  };

  const tabBtn = (id: typeof tab, label: string) => (
    <button onClick={() => setTab(id)} className={`whitespace-nowrap border-b-2 px-1 pb-2 text-sm ${tab === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}>
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-4 border-b border-border px-4 pt-3">
        {tabBtn("orders", `Orders${openCount ? ` (${openCount})` : ""}`)}
        {tabBtn("trades", "Trades")}
        <div className="ml-auto flex items-center gap-3 pb-2">
          {symbol && (
            <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted" title={`Only show ${symbol}`}>
              <input type="checkbox" checked={onlySymbol} onChange={(e) => setOnlySymbol(e.target.checked)} />
              This stock
            </label>
          )}
          {openCount > 0 && (
            <button onClick={() => setConfirmAll(true)} className="whitespace-nowrap rounded-md border border-down/50 px-2 py-0.5 text-xs font-medium text-down hover:bg-down/10">
              Cancel all
            </button>
          )}
        </div>
      </div>
      {error && <p className="border-b border-border bg-down/10 px-4 py-2 text-xs text-down">{error}</p>}

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "orders" ? (
          orders.error ? (
            <p className="p-4 text-xs text-down">{orders.error}</p>
          ) : orderRows.length === 0 ? (
            <p className="p-4 text-xs text-muted">{orders.loading ? "Loading…" : "No orders today."}</p>
          ) : (
            <ul className="divide-y divide-border">
              {orderRows.map((o) => (
                <li key={o.order_id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm">
                      <span className={`text-xs font-semibold ${o.side === "BUY" ? "text-up" : "text-down"}`}>{o.side}</span>
                      <Link href={`/trade/?symbol=${o.symbol}`} className="font-medium hover:underline">
                        {o.symbol}
                      </Link>
                      <StatusChip status={o.status} />
                      {o.source?.startsWith("qvrun") && <ScriptBadge tag={o.source} />}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {o.filled_quantity}/{o.quantity} · {o.order_type}
                      {o.price ? ` @ ${formatPrice(o.price)}` : ""}
                      {o.trigger_price ? ` · trg ${formatPrice(o.trigger_price)}` : ""} · {o.product} · {fmtTime(o.updated_at)}
                    </div>
                    {o.message && <div className="mt-0.5 text-xs text-down">{o.message}</div>}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {o.average_price ? <span className="font-mono text-xs tabular-nums">₹{formatPrice(o.average_price)}</span> : null}
                    {o.is_open && (
                      <button onClick={() => void cancel(o.order_id)} disabled={busy === o.order_id} className="text-xs text-down hover:underline disabled:opacity-50">
                        {busy === o.order_id ? "Cancelling…" : "Cancel"}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : trades.error ? (
          <p className="p-4 text-xs text-down">{trades.error}</p>
        ) : tradeRows.length === 0 ? (
          <p className="p-4 text-xs text-muted">{trades.loading ? "Loading…" : "No trades executed today."}</p>
        ) : (
          <ul className="divide-y divide-border">
            {tradeRows.map((t) => (
              <li key={t.trade_id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <div>
                  <span className={`mr-2 text-xs font-semibold ${t.side === "BUY" ? "text-up" : "text-down"}`}>{t.side}</span>
                  {t.quantity} × {t.symbol}
                  <div className="text-xs text-muted">
                    {t.product} · {fmtTime(t.time)}
                  </div>
                </div>
                <span className="font-mono text-xs tabular-nums">₹{formatPrice(t.price)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmAll}
        title={`Cancel all ${openCount} open order${openCount === 1 ? "" : "s"}?`}
        confirmLabel="Cancel all orders"
        tone="down"
        busy={busy === "all"}
        onConfirm={() => void cancelAll()}
        onCancel={() => setConfirmAll(false)}
      >
        Every pending and trigger-pending order will be cancelled. Filled orders aren&apos;t affected.
      </ConfirmDialog>
    </div>
  );
}
