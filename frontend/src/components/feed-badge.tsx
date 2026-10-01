"use client";

import { useFeedStatus } from "@/lib/market-socket";

export function FeedBadge() {
  const status = useFeedStatus();

  let dot = "bg-down";
  let label = "Engine offline";
  if (status) {
    const source = status.mode === "angelone" ? "Angel One" : status.mode === "simulated" ? "Simulated" : "Market data";
    label = status.state === "connected" ? `${source} · live` : `${source} · ${status.state}`;
    dot = status.state === "connected" ? (status.mode === "angelone" ? "bg-up" : "bg-accent") : "bg-down";
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted" title={status?.message || label}>
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </div>
  );
}
