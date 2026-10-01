"use client";

import Link from "next/link";
import { useTick } from "@/lib/market-socket";
import { changeColor, formatChange, formatPrice } from "@/lib/format";

export function IndexCard({ symbol, name }: { symbol: string; name: string }) {
  const tick = useTick(symbol);
  return (
    <Link href={`/trade/?symbol=${symbol}`} className="rounded-xl border border-border bg-surface p-4 hover:border-accent/60">
      <div className="text-xs text-muted">{name}</div>
      <div className="mt-1 font-mono text-xl tabular-nums">{formatPrice(tick?.ltp)}</div>
      <div className={`font-mono text-xs tabular-nums ${changeColor(tick?.change)}`}>{formatChange(tick?.change, tick?.change_pct)}</div>
    </Link>
  );
}

export function WatchlistRow({ symbol, name, active }: { symbol: string; name?: string; active?: boolean }) {
  const tick = useTick(symbol);
  return (
    <Link
      href={`/trade/?symbol=${symbol}`}
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 ${active ? "bg-accent/15" : "hover:bg-surface-2"}`}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{symbol}</div>
        {name && <div className="truncate text-xs text-muted">{name}</div>}
      </div>
      <div className="text-right font-mono tabular-nums">
        <div className="text-sm">{formatPrice(tick?.ltp)}</div>
        <div className={`text-xs ${changeColor(tick?.change)}`}>{tick?.change_pct != null ? `${tick.change_pct > 0 ? "+" : ""}${tick.change_pct.toFixed(2)}%` : "—"}</div>
      </div>
    </Link>
  );
}
