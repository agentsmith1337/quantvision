"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "./api";
import { useOrderEvents } from "./market-socket";

type Options = {
  /** Refetch shortly after any order update (fills change holdings, funds, positions…). */
  refreshOnOrders?: boolean;
  /** Also refetch on a timer (ms), e.g. for broker data that isn't pushed. */
  intervalMs?: number;
};

/** GET `path` (or nothing while it's null) and keep it fresh. */
export function useApi<T>(path: string | null, { refreshOnOrders = false, intervalMs }: Options = {}) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string | null }>({ path: null, data: null, error: null });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    apiGet<T>(path)
      .then((data) => !cancelled && setState({ path, data, error: null }))
      .catch((e: Error) => !cancelled && setState((s) => ({ path, data: s.path === path ? s.data : null, error: e.message })));
    return () => {
      cancelled = true;
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
