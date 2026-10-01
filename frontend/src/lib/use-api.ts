"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, isAbortError, isTransient } from "./api";
import { useOrderEvents } from "./market-socket";

type Options = {
  /** Refetch shortly after any order update (fills change holdings, funds, positions…). */
  refreshOnOrders?: boolean;
  /** Also refetch on a timer (ms), e.g. for broker data that isn't pushed. */
  intervalMs?: number;
};

const RETRY_DELAYS = [1000, 2000, 4000];

/**
 * GET `path` (or nothing while it's null) and keep it fresh. Requests are
 * cancelled when the path changes or the component unmounts, and transient
 * failures (Angel One rate limits) are retried with backoff.
 */
export function useApi<T>(path: string | null, { refreshOnOrders = false, intervalMs }: Options = {}) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>({ path: null, data: null, error: null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedPath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Only the first load of a path shows the progress bar; refreshes are background.
    const background = loadedPath.current === path;

    const attempt = (n: number) => {
      apiGet<T>(path, { signal: controller.signal, background })
        .then((data) => {
          loadedPath.current = path;
          setState({ path, data, error: null });
        })
        .catch((e: Error) => {
          if (isAbortError(e) || controller.signal.aborted) return;
          if (isTransient(e) && n < RETRY_DELAYS.length) {
            timer = setTimeout(() => attempt(n + 1), RETRY_DELAYS[n]);
            return;
          }
          setState((s) => ({ path, data: s.path === path ? s.data : null, error: e.message }));
        });
    };
    attempt(0);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [path, version]);

  useEffect(() => {
    if (!intervalMs || !path) return;
    const id = setInterval(reload, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, path, reload]);

  useOrderEvents(() => {
    if (!refreshOnOrders) return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(reload, 300);
  });

  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !current, reload };
}
