"use client";

import Link from "next/link";
import { useScripts } from "@/lib/scripts-store";
import { RunStateChip } from "./runs-panel";
import { ScriptEditor } from "./script-editor";
import { ScriptToolbar } from "./script-toolbar";

/** Compact IDE for the Trading Dashboard; shares its script with the Studio. */
export function QuickScript({ symbol }: { symbol: string }) {
  const runs = useScripts((s) => s.runs);
  const current = useScripts((s) => s.current);
  const latest = runs.find((r) => r.script === current);
  const activeCount = runs.filter((r) => r.active).length;

  return (
    <div className="flex flex-col gap-3">
      <ScriptToolbar defaultSymbol={symbol} />
      <div className="h-72 overflow-hidden rounded-lg border border-border">
        <ScriptEditor compact />
      </div>
      <div className="flex items-center gap-2 text-xs">
        {latest ? (
          <>
            <RunStateChip state={latest.state} />
            <span className="truncate text-muted">
              {latest.symbols.join(", ")} · {latest.candles} candles · {latest.orders} orders
            </span>
          </>
        ) : (
          <span className="text-muted">{activeCount ? `${activeCount} script${activeCount === 1 ? "" : "s"} running` : "Not running"}</span>
        )}
        <Link href="/backtest/" className="ml-auto shrink-0 rounded-md border border-accent/50 px-2 py-1 font-medium text-accent hover:bg-accent/10">
          Open in Backtester ↗
        </Link>
      </div>
    </div>
  );
}
