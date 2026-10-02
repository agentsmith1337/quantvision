"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { apiPost } from "@/lib/api";
import { marketSocket } from "@/lib/market-socket";
import { useScripts } from "@/lib/scripts-store";

/** Keeps the runs list in sync with the engine (mounted once in the shell). */
export function ScriptEventsBridge() {
  const applyEvent = useScripts((s) => s.applyEvent);
  const refreshRuns = useScripts((s) => s.refreshRuns);
  useEffect(() => {
    void refreshRuns();
    return marketSocket.subscribeScripts(applyEvent);
  }, [applyEvent, refreshRuns]);
  return null;
}

/** Top-bar emergency stop: every script, then every open order. Shown while scripts run. */
export function KillSwitch() {
  const active = useScripts((s) => s.runs.filter((r) => r.active).length);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!result) return;
    const id = setTimeout(() => setResult(null), 6000);
    return () => clearTimeout(id);
  }, [result]);

  const fire = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ stopped_runs: number; cancelled: string[]; failed: unknown[] }>("/api/kill-switch");
      setResult(`Stopped ${r.stopped_runs} script${r.stopped_runs === 1 ? "" : "s"}, cancelled ${r.cancelled.length} order${r.cancelled.length === 1 ? "" : "s"}${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
    } catch (e) {
      setResult(`Kill switch failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  if (!active && !result) return null;
  return (
    <>
      {active > 0 && (
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full bg-down px-3 py-1 text-xs font-bold tracking-wide text-white shadow hover:brightness-110"
          title="Stop all scripts and cancel all open orders"
        >
          <span className="size-2 animate-pulse rounded-full bg-white" />
          KILL SWITCH · {active} running
        </button>
      )}
      {result && <span className="text-xs text-muted">{result}</span>}
      <ConfirmDialog
        open={open}
        title="Stop all automated trading?"
        confirmLabel="Stop everything"
        tone="down"
        busy={busy}
        onConfirm={() => void fire()}
        onCancel={() => setOpen(false)}
      >
        Every running script is stopped immediately and every open order (manual or scripted) is cancelled. Filled orders and positions are not changed.
      </ConfirmDialog>
    </>
  );
}
