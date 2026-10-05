"use client";

import { useEffect, useRef, useState } from "react";

const FIELDS: { key: string; label: string; unit: "%" | "₹" }[] = [
  { key: "brokerage_pct", label: "Brokerage per order", unit: "%" },
  { key: "brokerage_max", label: "…capped at", unit: "₹" },
  { key: "brokerage_min", label: "…but at least", unit: "₹" },
  { key: "stt_delivery_pct", label: "STT, delivery (buy & sell)", unit: "%" },
  { key: "stt_intraday_sell_pct", label: "STT, intraday (sell)", unit: "%" },
  { key: "exchange_nse_pct", label: "NSE transaction charge", unit: "%" },
  { key: "ipft_pct", label: "NSE IPFT", unit: "%" },
  { key: "exchange_bse_pct", label: "BSE transaction charge", unit: "%" },
  { key: "sebi_pct", label: "SEBI turnover fee", unit: "%" },
  { key: "stamp_delivery_buy_pct", label: "Stamp duty, delivery (buy)", unit: "%" },
  { key: "stamp_intraday_buy_pct", label: "Stamp duty, intraday (buy)", unit: "%" },
  { key: "gst_pct", label: "GST on brokerage & fees", unit: "%" },
  { key: "dp_per_sell", label: "DP charge per delivery sell", unit: "₹" },
];

/** Edit Angel One's charges and the slippage for a script's backtests. */
export function CostsDialog({
  defaults,
  charges,
  slippage,
  onSave,
  onClose,
}: {
  defaults: Record<string, number>;
  charges: Record<string, number>;
  slippage: number;
  onSave: (charges: Record<string, number>, slippage: number) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, String(charges[f.key] ?? defaults[f.key] ?? "")])));
  const [slip, setSlip] = useState(String(slippage));

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const submit = () => {
    const overrides: Record<string, number> = {};
    for (const f of FIELDS) {
      const v = Number(values[f.key]);
      if (values[f.key] !== "" && Number.isFinite(v) && v >= 0 && v !== defaults[f.key]) overrides[f.key] = v;
    }
    const s = Number(slip);
    onSave(overrides, Number.isFinite(s) ? Math.min(Math.max(s, 0), 5) : slippage);
  };

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(94vw,34rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="space-y-4 p-5"
      >
        <div>
          <h2 className="text-base font-semibold">Trading costs</h2>
          <p className="mt-1 text-xs text-muted">
            Angel One&apos;s equity charges are deducted from every simulated fill. Defaults follow Angel One&apos;s published tariff; change them if yours differs.
          </p>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <span>
            Slippage
            <span className="block text-[11px] text-muted">Market and stop orders fill this much worse than the candle&apos;s price.</span>
          </span>
          <span className="flex items-center gap-1">
            <input value={slip} onChange={(e) => setSlip(e.target.value)} inputMode="decimal" className="w-20 rounded-md border border-border bg-surface px-2 py-1 text-right font-mono text-xs outline-none focus:border-accent" />
            <span className="text-xs text-muted">%</span>
          </span>
        </label>
        <div className="grid grid-cols-1 gap-x-5 gap-y-1.5 sm:grid-cols-2">
          {FIELDS.map((f) => {
            const changed = values[f.key] !== "" && Number(values[f.key]) !== defaults[f.key];
            return (
              <label key={f.key} className="flex items-center justify-between gap-2 text-xs">
                <span className={changed ? "text-accent" : "text-muted"}>{f.label}</span>
                <span className="flex items-center gap-1">
                  {f.unit === "₹" && <span className="text-muted">₹</span>}
                  <input
                    value={values[f.key]}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    inputMode="decimal"
                    className="w-24 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-right font-mono outline-none focus:border-accent"
                  />
                  {f.unit === "%" && <span className="text-muted">%</span>}
                </span>
              </label>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              setValues(Object.fromEntries(FIELDS.map((f) => [f.key, String(defaults[f.key] ?? "")])));
              setSlip("0.05");
            }}
            className="text-xs text-accent hover:underline"
          >
            Reset to Angel One defaults
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
              Cancel
            </button>
            <button type="submit" className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg">
              Save
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
