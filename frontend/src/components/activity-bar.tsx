"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { inflightStore } from "@/lib/api";

const SHOW_AFTER_MS = 200;

/**
 * Thin animated bar under the top bar while foreground requests are pending,
 * e.g. while a chart waits on Angel One's 1 request/second limit. Quick
 * requests never show it.
 */
export function ActivityBar() {
  const inflight = useSyncExternalStore(inflightStore.subscribe, inflightStore.get, () => 0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (inflight === 0) {
      const id = setTimeout(() => setVisible(false), 150);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(id);
  }, [inflight]);

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden transition-opacity duration-200 ${visible ? "opacity-100" : "opacity-0"}`}
      role="progressbar"
      aria-hidden={!visible}
      aria-label="Loading"
    >
      <div className="h-full w-1/3 animate-[qv-progress_1.1s_ease-in-out_infinite] rounded-full bg-accent" />
    </div>
  );
}
