"use client";

import { useEffect, useRef, useState } from "react";
import { apiPost, type RunInfo } from "@/lib/api";
import { useScripts } from "@/lib/scripts-store";

const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function RunStateChip({ state }: { state: RunInfo["state"] }) {
  const tone = {
    starting: "bg-accent/15 text-accent",
    running: "bg-up/15 text-up",
    stopping: "bg-surface-2 text-muted",
    stopped: "bg-surface-2 text-muted",
    finished: "bg-surface-2 text-muted",
    failed: "bg-down/15 text-down",
  }[state];
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${tone}`}>{state}</span>;
}

/** Runs list + the selected run's live log. */
export function RunsPanel({ script }: { script?: string | null }) {
  const runs = useScripts((s) => s.runs);
  const logs = useScripts((s) => s.logs);
  const loadLogs = useScripts((s) => s.loadLogs);
  const [onlyThis, setOnlyThis] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = runs.filter((r) => !onlyThis || !script || r.script === script);
  const active = selected && shown.some((r) => r.id === selected) ? selected : shown[0]?.id ?? null;
  const run = runs.find((r) => r.id === active);
  const lines = active ? (logs[active] ?? []) : [];
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (active) void loadLogs(active);
  }, [active, loadLogs]);

  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">Runs</span>
        {script && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} />
            This script only
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="p-4 text-xs text-muted">No runs yet. Press Run to start the script on paper or live.</p>
      ) : (
        <>
          <ul className="max-h-40 shrink-0 divide-y divide-border overflow-auto border-b border-border">
            {shown.map((r) => (
              <li key={r.id}>
                <button onClick={() => setSelected(r.id)} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${r.id === active ? "bg-surface-2" : "hover:bg-surface-2/60"}`}>
                  <RunStateChip state={r.state} />
                  <span className="font-mono">{r.script}</span>
                  <span className="truncate text-muted">
                    {r.symbols.join(", ")} · {r.interval}
                  </span>
                  <span className="ml-auto shrink-0 text-muted" title="candles · orders · errors">
                    {r.candles}c · {r.orders}o{r.errors ? <span className="text-down"> · {r.errors}e</span> : ""}
                  </span>
                  {r.active && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        void apiPost(`/api/runs/${r.id}/stop`);
                      }}
                      onKeyDown={(e) => e.key === "Enter" && void apiPost(`/api/runs/${r.id}/stop`)}
                      className="shrink-0 rounded border border-down/50 px-1.5 py-0.5 text-[10px] font-medium text-down hover:bg-down/10"
                    >
                      Stop
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {run?.message && <p className={`border-b border-border px-3 py-1.5 text-xs ${run.state === "failed" ? "text-down" : "text-muted"}`}>{run.message}</p>}
          <div
            ref={logRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
            className="min-h-0 flex-1 overflow-auto bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed"
            aria-live="polite"
          >
            {lines.map((l) => (
              <div key={l.seq} className={`whitespace-pre-wrap break-words ${l.level === "error" ? "text-down" : l.level === "warning" ? "text-warn" : "text-fg"}`}>
                <span className="mr-2 text-muted">{timeFmt.format(new Date(l.ts * 1000))}</span>
                {l.text}
              </div>
            ))}
            {lines.length === 0 && <span className="text-muted">No log output yet.</span>}
          </div>
        </>
      )}
    </div>
  );
}
