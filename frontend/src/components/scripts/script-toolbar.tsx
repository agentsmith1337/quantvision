"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { isDirty, useScripts } from "@/lib/scripts-store";
import { RunDialog } from "./run-dialog";

const btn = "rounded-md border border-border px-2.5 py-1 text-xs hover:bg-surface-2 disabled:opacity-50";

/** Script picker + file actions + Save + Run, used by the dashboard and the Studio. */
export function ScriptToolbar({ defaultSymbol, children }: { defaultSymbol?: string; children?: React.ReactNode }) {
  const { scripts, current, open, openInitial, save, create, rename, remove, syntaxError, error } = useScripts();
  const dirty = useScripts(isDirty);
  const [prompt, setPrompt] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void openInitial();
  }, [openInitial]);

  const submitName = async () => {
    setBusy(true);
    setMessage(null);
    try {
      if (prompt === "new") await create(name.trim());
      else await rename(name.trim());
      setPrompt(null);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={current ?? ""}
        onChange={(e) => void open(e.target.value)}
        aria-label="Script"
        className="max-w-48 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
      >
        {!current && <option value="">No scripts</option>}
        {scripts.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      <button className={btn} onClick={() => { setName(""); setPrompt("new"); }}>
        New
      </button>
      <button className={btn} disabled={!current} onClick={() => { setName(current?.replace(/\.py$/, "") ?? ""); setPrompt("rename"); }}>
        Rename
      </button>
      <button className={`${btn} text-down`} disabled={!current} onClick={() => setConfirmDelete(true)}>
        Delete
      </button>
      <button className={`${btn} ${dirty ? "border-accent text-accent" : ""}`} disabled={!current || !dirty} onClick={() => void save()} title="Ctrl+S">
        {dirty ? "Save •" : "Saved"}
      </button>
      {children}
      <button
        onClick={() => setRunning(true)}
        disabled={!current}
        className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-accent-fg disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-3" aria-hidden>
          <path d="M7 4v16l13-8z" />
        </svg>
        Run
      </button>

      {(syntaxError || error || message) && <p className="basis-full text-xs text-down">{syntaxError ? `Syntax error: ${syntaxError}` : (error ?? message)}</p>}

      {prompt && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitName();
          }}
          className="flex basis-full items-center gap-2"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, "_"))}
            placeholder={prompt === "new" ? "new_strategy" : "name"}
            className="w-56 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-xs outline-none focus:border-accent"
          />
          <span className="text-xs text-muted">.py</span>
          <button type="submit" disabled={busy || !name.trim()} className={btn}>
            {prompt === "new" ? "Create" : "Rename"}
          </button>
          <button type="button" className={btn} onClick={() => setPrompt(null)}>
            Cancel
          </button>
        </form>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${current}?`}
        confirmLabel="Delete"
        tone="down"
        onConfirm={() => {
          setConfirmDelete(false);
          remove().catch((e: Error) => setMessage(e.message));
        }}
        onCancel={() => setConfirmDelete(false)}
      >
        The file is removed from Documents/QuantVision/scripts. This can&apos;t be undone.
      </ConfirmDialog>
      {running && current && <RunDialog script={current} defaultSymbol={defaultSymbol} onClose={() => setRunning(false)} />}
    </div>
  );
}
