"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SymbolSearch } from "@/components/symbol-search";
import type { BacktestConfig, Interval, RuntimeStatus } from "@/lib/api";
import { defaultSettings, isActive, useBacktests, type BacktestSettings } from "@/lib/backtest-store";
import { isDirty, useScripts } from "@/lib/scripts-store";
import { useApi } from "@/lib/use-api";
import { CostsDialog } from "./costs-dialog";

const INTERVALS: Interval[] = ["1d", "1h", "15m", "5m", "1m"];
const LIMITS: Record<Interval, string> = {
  "1d": "Daily candles: decades of history",
  "1h": "Hourly candles: Yahoo Finance keeps the last 730 days",
  "15m": "15-minute candles: Yahoo Finance keeps the last 60 days",
  "5m": "5-minute candles: Yahoo Finance keeps the last 60 days",
  "1m": "1-minute candles: Yahoo Finance keeps the last 30 days",
};
const field = "rounded-md border border-border bg-surface-2 px-2 py-1 text-xs outline-none focus:border-accent";
const label = "flex flex-col gap-1 text-[11px] font-medium text-muted";

/** The Studio's backtest configuration: stocks, candles, dates, capital and costs, then Run simulation. */
export function BacktestBar({ script }: { script: string }) {
  const defaults = useScripts((s) => s.defaults);
  const dirty = useScripts(isDirty);
  const save = useScripts((s) => s.save);
  const { hydrate, settingsFor, setSettings, start, cancel, current, starting, error } = useBacktests();
  const config = useApi<BacktestConfig>("/api/backtests/config");
  const runtime = useApi<RuntimeStatus>("/api/scripts/runtime", { intervalMs: 5000 });
  const [adding, setAdding] = useState(false);
  const [costs, setCosts] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => hydrate(), [hydrate]);

  const fallback = useMemo(() => defaultSettings(defaults?.symbols ?? undefined, (defaults?.interval ?? undefined) as Interval | undefined), [defaults]);
  const s = settingsFor(script, fallback);
  const update = (patch: Partial<BacktestSettings>) => setSettings(script, { ...s, ...patch });
  const earliest = config.data?.intervals[s.interval]?.earliest ?? null;
  const today = config.data?.today;
  const running = isActive(current?.info) && current?.info.script === script;
  const otherRunning = isActive(current?.info) && current?.info.script !== script;
  const tooEarly = !!earliest && s.start < earliest;
  const inverted = s.start > s.end;
  const ready = runtime.data?.state === "ready";
  const customCosts = Object.keys(s.charges).length > 0;

  const chooseInterval = (interval: Interval) => {
    const first = config.data?.intervals[interval]?.earliest;
    if (!first || s.start >= first) return update({ interval });
    // Yahoo doesn't have this interval that far back: start at the earliest date, and keep the range valid.
    update({ interval, start: first, ...(s.end < first && today ? { end: today } : {}) });
  };

  const run = async () => {
    setSaveError(null);
    if (dirty && !(await save())) {
      setSaveError("Couldn't save the script first");
      return;
    }
    await start(script, s);
  };

  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div className={`${label} min-w-0 flex-1 basis-72`}>
        Stocks ({s.symbols.length}/{config.data?.max_symbols ?? 20})
        <div className="flex min-h-7 flex-wrap items-center gap-1">
          {s.symbols.map((sym) => (
            <span key={sym} className="flex items-center gap-0.5 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 font-mono text-xs text-fg">
              {sym}
              <button onClick={() => update({ symbols: s.symbols.filter((x) => x !== sym) })} aria-label={`Remove ${sym}`} className="rounded px-1 text-muted hover:text-down">
                ×
              </button>
            </span>
          ))}
          {s.symbols.length < (config.data?.max_symbols ?? 20) && (
            <AddStock open={adding} setOpen={setAdding} onAdd={(sym) => !s.symbols.includes(sym) && update({ symbols: [...s.symbols, sym] })} />
          )}
          {defaults?.symbols?.length && s.symbols.join() !== defaults.symbols?.join() ? (
            <button onClick={() => update({ symbols: (defaults.symbols ?? []).slice(0, 20) })} className="text-[11px] text-accent hover:underline" title="Use the script's SYMBOLS">
              Reset to SYMBOLS
            </button>
          ) : null}
        </div>
      </div>

      <div className={label}>
        Candles
        <div className="flex rounded-lg bg-surface-2 p-0.5">
          {INTERVALS.map((i) => (
            <button
              key={i}
              onClick={() => chooseInterval(i)}
              title={LIMITS[i]}
              className={`rounded-md px-2 py-0.5 text-xs ${s.interval === i ? "bg-surface font-semibold text-fg shadow-sm" : "text-muted hover:text-fg"}`}
            >
              {i}
            </button>
          ))}
        </div>
      </div>

      <label className={label}>
        From
        <input type="date" value={s.start} min={earliest ?? undefined} max={s.end} onChange={(e) => e.target.value && update({ start: e.target.value })} className={`${field} ${tooEarly ? "border-down" : ""}`} />
      </label>
      <label className={label}>
        To
        <input type="date" value={s.end} min={s.start} max={today} onChange={(e) => e.target.value && update({ end: e.target.value })} className={field} />
      </label>
      <label className={label}>
        Capital (₹)
        <input
          type="number"
          min={1000}
          step={10000}
          value={s.capital}
          onChange={(e) => update({ capital: Math.max(0, Number(e.target.value) || 0) })}
          className={`${field} w-32 font-mono`}
        />
      </label>
      <button onClick={() => setCosts(true)} className={`${field} self-end hover:bg-surface ${customCosts ? "border-accent text-accent" : "text-fg"}`} title="Angel One charges and slippage">
        Costs · {s.slippage_pct}% slip{customCosts ? " · custom" : ""}
      </button>

      <div className="ml-auto flex items-center gap-2 self-end">
        {running ? (
          <>
            <div className="w-40" title={current?.info.message}>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round((current?.info.progress ?? 0) * 100)}%` }} />
              </div>
              <div className="mt-0.5 truncate text-[10px] text-muted">{current?.info.message || "Starting…"}</div>
            </div>
            <button onClick={() => void cancel()} className="rounded-md border border-down/50 px-3 py-1 text-xs font-semibold text-down hover:bg-down/10">
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => void run()}
            disabled={starting || otherRunning || !ready || s.symbols.length === 0 || tooEarly || inverted || s.capital < 1000}
            title={otherRunning ? "Another backtest is running" : !ready ? "The script environment is being set up" : "Simulate this script on historical candles"}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} className="size-3.5" aria-hidden>
              <path d="M3 3v18h18M7 15l4-4 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {starting ? "Starting…" : "Run simulation"}
          </button>
        )}
      </div>

      {(tooEarly || inverted || error || saveError || (runtime.data && !ready)) && (
        <p className={`basis-full text-xs ${tooEarly || inverted || error || saveError ? "text-down" : "text-muted"}`}>
          {tooEarly
            ? `${LIMITS[s.interval]}: start on or after ${earliest}.`
            : inverted
              ? "The start date must be before the end date."
            : (saveError ?? error ?? (runtime.data?.state === "error" ? runtime.data.message : runtime.data?.message || "Preparing the script environment…"))}
        </p>
      )}
      {costs && (
        <CostsDialog
          defaults={config.data?.charges ?? {}}
          charges={s.charges}
          slippage={s.slippage_pct}
          onSave={(charges, slippage_pct) => {
            update({ charges, slippage_pct });
            setCosts(false);
          }}
          onClose={() => setCosts(false)}
        />
      )}
    </div>
  );
}

function AddStock({ open, setOpen, onAdd }: { open: boolean; setOpen: (v: boolean) => void; onAdd: (symbol: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-accent">
        + Add
      </button>
      {open && (
        <div className="absolute left-0 top-8 z-40 w-72 rounded-lg border border-border bg-surface p-2 shadow-xl">
          <SymbolSearch
            placeholder="Add a stock or index…"
            onSelect={(i) => {
              onAdd(i.symbol);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
