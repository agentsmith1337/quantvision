"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

/**
 * Fallback for any page that throws while rendering. It sits inside the app
 * shell, so navigation keeps working, and retries once on its own because most
 * failures here are transient (e.g. the broker briefly refusing requests).
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const retried = useRef(false);

  useEffect(() => {
    console.error("Page error:", error);
    if (retried.current) return;
    retried.current = true;
    const id = setTimeout(retry, 1500);
    return () => clearTimeout(id);
  }, [error, retry]);

  return (
    <div className="grid h-full place-items-center p-6">
      <div className="max-w-md rounded-xl border border-border bg-surface p-6 text-center">
        <h1 className="font-display text-lg font-semibold">This view hit a problem</h1>
        <p className="mt-2 text-sm text-muted">Trying again automatically… If it keeps happening, the engine log in your terminal will have details.</p>
        {error.message && <p className="mt-3 break-words rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-muted">{error.message}</p>}
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={retry} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg">
            Try again
          </button>
          <Link href="/portfolio/" className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2">
            Go to Portfolio
          </Link>
        </div>
      </div>
    </div>
  );
}
