"use client";

import { useEffect, useRef, useState } from "react";
import { SymbolSearch } from "@/components/symbol-search";
import { ApiError, apiPost, type Interval, type RunInfo, type RuntimeStatus } from "@/lib/api";
import { useBrokerStatus } from "@/lib/broker-status";
import { isDirty, useScripts } from "@/lib/scripts-store";
import { useApi } from "@/lib/use-api";

const INTERVALS: Interval[] = ["1m", "5m", "15m", "1h", "1d"];
const MAX_SYMBOLS = 20;

/** Choose the universe and interval, then start a run. */
export function RunDialog({ script, defaultSymbol, onClose }: { script: string; defaultSymbol?: string; onClose: () => void }) {
  const defaults = useScripts((s) => s.defaults);
  const dirty = useScripts(isDirty);
  const save = useScripts((s) => s.save);
  const applyEvent = useScripts((s) => s.applyEvent);
  const { status: broker } = useBrokerStatus();
  const live = broker?.trading_mode === "live";
  const runtime = useApi<RuntimeStatus>("/api/scripts/runtime", { intervalMs: 3000 });
  const [symbols, setSymbols] = useState<string[]>(() => defaults?.symbols?.length ? defaults.symbols : defaultSymbol ? [defaultSymbol] : []);
  const [interval, setIntervalValue] = useState<Interval>(defaults?.interval ?? "5m");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const ready = runtime.data?.state === "ready";

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dirty && !(await save())) throw new Error("Couldn't save the script first");
      const run = await apiPost<RunInfo>("/api/runs", { script, symbols, interval });
      applyEvent({ kind: "run", run });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(94vw,32rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50"
    >
      <div className="space-y-4 p-5">
        <div>
          <h2 className="text-base font-semibold">Run {script}</h2>
          <p className="mt-1 text-xs text-muted">on_candle is called each time a candle closes, for every stock below.</p>
        </div>

        <div>
          <div className="mb-1.5 text-xs font-medium text-muted">
            Stocks ({symbols.length}/{MAX_SYMBOLS})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {symbols.map((s) => (
              <span key={s} className="flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-xs">
                {s}
                <button onClick={() => setSymbols((xs) => xs.filter((x) => x !== s))} aria-label={`Remove ${s}`} className="rounded px-1 text-muted hover:text-down">
                  ×
                </button>
              </span>
            ))}
            {symbols.length === 0 && <span className="text-xs text-muted">Add at least one stock.</span>}
          </div>
          {symbols.length < MAX_SYMBOLS && (
            <SymbolSearch className="mt-2" placeholder="Add a stock or index…" onSelect={(i) => setSymbols((xs) => (xs.includes(i.symbol) ? xs : [...xs, i.symbol]))} />
          )}
        </div>

        <label className="block text-xs font-medium text-muted">
          Candle interval
          <div className="mt-1.5 flex gap-1 rounded-lg bg-surface-2 p-0.5">
            {INTERVALS.map((i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIntervalValue(i)}
                className={`flex-1 rounded-md py-1 text-xs ${interval === i ? "bg-surface font-semibold text-fg shadow-sm" : "text-muted hover:text-fg"}`}
              >
                {i}
              </button>
            ))}
          </div>
        </label>

        <p className={`rounded-lg px-3 py-2 text-xs ${live ? "bg-down/10 text-down" : "bg-accent/10 text-accent"}`}>
          {live
            ? "LIVE mode: this script's orders go to Angel One with real money. Risk limits and the Kill switch apply."
            : "Paper mode: orders are simulated against live prices. Switching to Live while it runs makes its next orders live."}
        </p>

        {!ready && runtime.data && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            {runtime.data.state === "error" ? runtime.data.message : runtime.data.message || "Preparing the script environment…"}
          </p>
        )}
        {error && <p className="text-xs text-down">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            Cancel
          </button>
          <button
            onClick={() => void start()}
            disabled={busy || !ready || symbols.length === 0}
            className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${live ? "bg-down text-white" : "bg-accent text-accent-fg"}`}
          >
            {busy ? "Starting…" : live ? "Run LIVE" : "Run on paper"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
