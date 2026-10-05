"use client";

import { useEffect, useState } from "react";
import { BacktestBar } from "@/components/backtest/backtest-bar";
import { BacktestResults } from "@/components/backtest/backtest-results";
import { ScriptEditor } from "@/components/scripts/script-editor";
import { ScriptToolbar } from "@/components/scripts/script-toolbar";
import { RunsPanel } from "@/components/scripts/runs-panel";
import { SdkReference } from "@/components/scripts/sdk-reference";
import { isActive, useBacktests } from "@/lib/backtest-store";
import { useScripts } from "@/lib/scripts-store";

type Pane = "reference" | "results" | "runs";

/** Backtesting Studio: configuration bar, full-height editor, and results / reference / live runs. */
export default function StudioPage() {
  const current = useScripts((s) => s.current);
  const hasRuns = useScripts((s) => s.runs.some((r) => r.script === s.current));
  const hasBacktest = useBacktests((s) => s.current?.info.script === current || s.history.length > 0);
  const refreshHistory = useBacktests((s) => s.refreshHistory);
  useEffect(() => {
    if (current) void refreshHistory(current); // so a script with earlier backtests opens on its results
  }, [current, refreshHistory]);
  const [pane, setPane] = useState<Pane | null>(null);
  const activeId = useBacktests((s) => (isActive(s.current?.info) ? s.current?.info.id : null));
  const [shownFor, setShownFor] = useState<string | null>(null);
  // A newly started simulation brings its results into view.
  if (activeId && activeId !== shownFor) {
    setShownFor(activeId);
    setPane("results");
  }
  // ...and deploying the script brings its live run into view.
  const startingRun = useScripts((s) => s.runs.find((r) => r.script === s.current && r.state === "starting")?.id ?? null);
  if (startingRun && startingRun !== shownFor) {
    setShownFor(startingRun);
    setPane("runs");
  }
  const shown: Pane = pane ?? (hasBacktest ? "results" : hasRuns ? "runs" : "reference");

  const tab = (id: Pane, label: string) => (
    <button
      onClick={() => setPane(id)}
      className={`border-b-2 px-1 pb-2 text-sm ${shown === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-[640px] flex-col gap-3 p-4">
      <div className="space-y-3 rounded-xl border border-border bg-surface px-4 py-3">
        <ScriptToolbar runLabel="Deploy" runTitle="Run this script on live prices (paper or live, following the Paper/Live switch)" />
        {current && (
          <div className="border-t border-border pt-3">
            <BacktestBar script={current} />
          </div>
        )}
      </div>
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(26rem,1fr)]">
        <section className="min-h-[400px] overflow-hidden rounded-xl border border-border bg-surface">
          <ScriptEditor />
        </section>
        <section className="flex min-h-[400px] flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex gap-4 border-b border-border px-4 pt-3">
            {tab("results", "Backtest results")}
            {tab("reference", "Reference")}
            {tab("runs", "Live runs")}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {shown === "reference" && (
              <div className="p-5">
                <SdkReference compact />
              </div>
            )}
            {shown === "results" && current && <BacktestResults script={current} />}
            {shown === "runs" && <RunsPanel script={current} />}
          </div>
        </section>
      </div>
    </div>
  );
}
