"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Prefs } from "@/lib/api";
import { formatPrice } from "@/lib/format";
import { useOrderEvents, type OrderEvent } from "@/lib/market-socket";
import { useApi } from "@/lib/use-api";

type Card = OrderEvent & { key: string; at: number };
const VISIBLE_MS = 8000;

/** Slides in when an order fills or is rejected, wherever the user is in the app. */
export function ExecutionSidecard() {
  const [cards, setCards] = useState<Card[]>([]);
  const { data: features } = useApi<Prefs["features"]>("/api/settings/features");

  useOrderEvents((e) => {
    const status = e.order.status;
    if (status !== "complete" && status !== "rejected") return;
    if (features && !features.execution_popups) return;
    const key = `${e.order.order_id}:${status}`;
    setCards((cs) => (cs.some((c) => c.key === key) ? cs : [{ ...e, key, at: Date.now() }, ...cs].slice(0, 4)));
  });

  useEffect(() => {
    if (cards.length === 0) return;
    const oldest = Math.min(...cards.map((c) => c.at));
    const id = setTimeout(() => setCards((cs) => cs.filter((c) => Date.now() - c.at < VISIBLE_MS)), oldest + VISIBLE_MS - Date.now() + 50);
    return () => clearTimeout(id);
  }, [cards]);

  return (
    <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-80 flex-col gap-2" aria-live="polite">
      {cards.map(({ key, order, broker }) => {
        const filled = order.status === "complete";
        const buy = order.side === "BUY";
        return (
          <div key={key} className="pointer-events-auto animate-[qv-slide-in_200ms_ease-out] rounded-xl border border-border bg-surface p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-2">
              <span className={`text-xs font-semibold ${filled ? (buy ? "text-up" : "text-down") : "text-down"}`}>
                {filled ? `${order.side} EXECUTED` : "ORDER REJECTED"}
              </span>
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{broker}</span>
            </div>
            <Link href={`/trade/?symbol=${order.symbol}`} className="mt-1 block text-sm font-medium hover:underline">
              {order.filled_quantity || order.quantity} × {order.symbol}
            </Link>
            <div className="text-xs text-muted">
              {filled ? `@ ₹${formatPrice(order.average_price)} · ${order.product} · ${order.order_type}` : order.message || "Rejected by the broker"}
            </div>
            <button
              className="mt-2 text-xs text-muted hover:text-fg"
              onClick={() => setCards((cs) => cs.filter((c) => c.key !== key))}
            >
              Dismiss
            </button>
          </div>
        );
      })}
    </div>
  );
}
