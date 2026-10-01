"use client";

import { createContext, useContext } from "react";
import type { BrokerStatus } from "./api";
import { useApi } from "./use-api";

type Value = { status: BrokerStatus | null; reload: () => void };

const BrokerStatusContext = createContext<Value>({ status: null, reload: () => {} });

/** Paper/live mode and credential state, shared by the top bar, order ticket and settings. */
export function BrokerStatusProvider({ children }: { children: React.ReactNode }) {
  const { data, reload } = useApi<BrokerStatus>("/api/broker/status", { intervalMs: 30_000 });
  return <BrokerStatusContext.Provider value={{ status: data, reload }}>{children}</BrokerStatusContext.Provider>;
}

export function useBrokerStatus(): Value {
  return useContext(BrokerStatusContext);
}
