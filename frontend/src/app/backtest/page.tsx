"use client";

import { useState } from "react";
import { ScriptEditor } from "@/components/scripts/script-editor";
import { ScriptToolbar } from "@/components/scripts/script-toolbar";
import { RunsPanel } from "@/components/scripts/runs-panel";
import { SdkReference } from "@/components/scripts/sdk-reference";
import { useScripts } from "@/lib/scripts-store";

/** Strategy Studio: full-height editor, live runs, and the SDK reference. Backtests arrive in Phase 4. */
export default function StudioPage() {
  const current = useScripts((s) => s.current);
  const hasRuns = useScripts((s) => s.runs.length > 0);
  const [pane, setPane] = useState<"reference" | "runs" | null>(null);
  const shown = pane ?? (hasRuns ? "runs" : "reference");

  const tab = (id: "reference" | "runs", label: string) => (
    <button
      onClick={() => setPane(id)}
      className={`border-b-2 px-1 pb-2 text-sm ${shown === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-[600px] flex-col gap-3 p-4">
      <div className="rounded-xl border border-border bg-surface px-4 py-3">
        <ScriptToolbar>
          <button
            disabled
            title="Backtesting arrives in Phase 4"
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted opacity-60"
          >
            Run simulation · Phase 4
          </button>
        </ScriptToolbar>
      </div>
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
        <section className="min-h-[400px] overflow-hidden rounded-xl border border-border bg-surface">
          <ScriptEditor />
        </section>
        <section className="flex min-h-[400px] flex-col overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex gap-4 border-b border-border px-4 pt-3">
            {tab("reference", "Reference")}
            {tab("runs", "Runs & logs")}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {shown === "reference" ? (
              <div className="p-5">
                <SdkReference compact />
              </div>
            ) : (
              <RunsPanel script={current} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
