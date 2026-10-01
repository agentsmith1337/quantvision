"use client";

import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  tone?: "up" | "down" | "accent";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Modal confirmation built on <dialog> (never window.confirm). */
export function ConfirmDialog({ open, title, children, confirmLabel, tone = "accent", busy, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const toneClass = { up: "bg-up text-white", down: "bg-down text-white", accent: "bg-accent text-accent-fg" }[tone];

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="m-auto w-[min(92vw,26rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/50"
    >
      <div className="p-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-3 text-sm">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted hover:bg-surface-2 hover:text-fg">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={busy} autoFocus className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-60 ${toneClass}`}>
            {busy ? "Sending…" : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
