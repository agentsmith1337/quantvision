"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BRICK_CHARTS, CHART_TYPES, INDICATOR_GROUPS, INDICATOR_LABELS, type ChartType, type IndicatorId } from "./chart/catalog";

/** "Indicators" dropdown with grouped checkboxes, plus removable chips for active ones. */
export function IndicatorMenu({
  value,
  onChange,
  chartType,
}: {
  value: ReadonlySet<IndicatorId>;
  onChange: Dispatch<SetStateAction<ReadonlySet<IndicatorId>>>;
  chartType: ChartType;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const bricks = BRICK_CHARTS.has(chartType);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = (id: IndicatorId) =>
    onChange((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const active = INDICATOR_GROUPS.flatMap((g) => g.items).filter((i) => value.has(i.id));

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <div className="relative" ref={ref}>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="size-3.5" aria-hidden>
            <path d="M3 17 9 11l4 4 8-8M15 7h6v6" />
          </svg>
          Indicators{value.size ? ` (${value.size})` : ""}
        </button>
        {open && (
          <div className="absolute left-0 top-9 z-40 grid w-[34rem] grid-cols-2 gap-4 rounded-xl border border-border bg-surface p-4 shadow-2xl">
            {INDICATOR_GROUPS.map((group) => (
              <div key={group.title}>
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{group.title}</div>
                <ul className="space-y-0.5">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2" title={item.hint}>
                        <input type="checkbox" checked={value.has(item.id)} onChange={() => toggle(item.id)} className="mt-0.5" />
                        <span>
                          <span className="block text-sm">{item.label}</span>
                          <span className="block text-[11px] leading-snug text-muted">{item.hint}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {bricks && (
              <p className="col-span-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                Indicators are hidden on {CHART_TYPES.find((c) => c.id === chartType)?.label} charts, which have no time axis. Your selection returns when you switch back.
              </p>
            )}
          </div>
        )}
      </div>
      {!bricks &&
        active.map((i) => (
          <span key={i.id} className="flex items-center gap-1 rounded-md bg-accent/15 py-0.5 pl-2 pr-1 text-xs text-accent">
            {INDICATOR_LABELS[i.id]}
            <button onClick={() => toggle(i.id)} aria-label={`Remove ${i.label}`} className="rounded px-1 hover:bg-accent/20">
              ×
            </button>
          </span>
        ))}
    </div>
  );
}

export function ChartTypeSelect({ value, onChange }: { value: ChartType; onChange: (t: ChartType) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only">Chart type</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ChartType)}
        title={CHART_TYPES.find((c) => c.id === value)?.hint}
        className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs text-fg outline-none focus:border-accent"
      >
        <optgroup label="Time-based">
          {CHART_TYPES.filter((c) => !BRICK_CHARTS.has(c.id)).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Price-movement">
          {CHART_TYPES.filter((c) => BRICK_CHARTS.has(c.id)).map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}
