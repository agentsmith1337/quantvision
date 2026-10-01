"use client";

import { useEffect, useId, useRef, useState } from "react";
import { apiGet, type Instrument } from "@/lib/api";

type Props = {
  onSelect: (inst: Instrument) => void;
  placeholder?: string;
  className?: string;
  id?: string;
};

/** Debounced instrument search (Angel One search when connected, built-ins otherwise). */
export function SymbolSearch({ onSelect, placeholder = "Search stocks…", className = "", id }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; items: Instrument[]; error?: string } | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const id = setTimeout(() => {
      apiGet<Instrument[]>(`/api/market/search?q=${encodeURIComponent(q)}`)
        .then((items) => {
          if (cancelled) return;
          setResults({ query: q, items });
          setActive(0);
        })
        .catch((e: Error) => !cancelled && setResults({ query: q, items: [], error: e.message }));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query]);

  useEffect(() => {
    const close = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const items = query.trim().length >= 2 && results?.query === query.trim() ? results.items : [];
  const pick = (inst: Instrument) => {
    onSelect(inst);
    setQuery("");
    setOpen(false);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <input
        id={id}
        value={query}
        maxLength={32}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, items.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && items[active]) pick(items[active]);
          else if (e.key === "Escape") setOpen(false);
          else return;
          e.preventDefault();
        }}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open && items.length > 0}
        aria-controls={listId}
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
      />
      {open && query.trim().length >= 2 && (
        <ul id={listId} role="listbox" className="absolute z-40 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-border bg-surface py-1 shadow-xl">
          {results?.query !== query.trim() && <li className="px-3 py-2 text-xs text-muted">Searching…</li>}
          {results?.query === query.trim() && results.error && <li className="px-3 py-2 text-xs text-down">Search failed: {results.error}</li>}
          {results?.query === query.trim() && !results.error && items.length === 0 && <li className="px-3 py-2 text-xs text-muted">No matches</li>}
          {items.map((inst, i) => (
            <li
              key={inst.symbol}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(inst);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm ${i === active ? "bg-surface-2" : ""}`}
            >
              <span className="font-medium">{inst.symbol}</span>
              <span className="truncate text-xs text-muted">
                {inst.is_index ? "Index" : inst.name} · {inst.exchange}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
