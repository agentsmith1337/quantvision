"use client";

// Backtests in the Studio (Zustand): the settings for each script, the backtest on screen
// (polled while it runs) and the script's earlier backtests.

import { create } from "zustand";
import { apiDelete, apiGet, apiPost, type BacktestInfo, type BacktestLog, type BacktestPayload, type Interval } from "./api";

export type BacktestSettings = {
  symbols: string[];
  interval: Interval;
  start: string;
  end: string;
  capital: number;
  slippage_pct: number;
  charges: Record<string, number>; // overrides of the default Angel One charges
};

const SETTINGS_KEY = "qv.backtest.settings";
const POLL_MS = 700;
const MAX_LOGS = 5000;
const ACTIVE = new Set(["preparing", "running"]);

export const isActive = (info?: BacktestInfo | null) => !!info && ACTIVE.has(info.state);

function loadSaved(): Record<string, BacktestSettings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function persist(all: Record<string, BacktestSettings>) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
  } catch {}
}

const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Sensible starting settings: the script's SYMBOLS, daily candles, the last three years. */
export function defaultSettings(symbols: string[] | undefined, interval: Interval | undefined): BacktestSettings {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 3);
  return {
    symbols: symbols?.length ? symbols.slice(0, 20) : ["RELIANCE"],
    interval: interval === "1d" || interval === "1h" ? interval : "1d",
    start: isoDate(start),
    end: isoDate(end),
    capital: 1_000_000,
    slippage_pct: 0.05,
    charges: {},
  };
}

type BacktestStore = {
  saved: Record<string, BacktestSettings>;
  hydrated: boolean;
  current: BacktestPayload | null;
  history: BacktestInfo[];
  error: string | null;
  starting: boolean;

  hydrate: () => void; // settings saved in this browser, loaded after mount (not during prerender)
  settingsFor: (script: string, fallback: BacktestSettings) => BacktestSettings;
  setSettings: (script: string, settings: BacktestSettings) => void;
  start: (script: string, settings: BacktestSettings) => Promise<void>;
  open: (id: string) => Promise<void>;
  cancel: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  refreshHistory: (script: string) => Promise<void>;
  clear: () => void;
};

let timer: ReturnType<typeof setTimeout> | null = null;

export const useBacktests = create<BacktestStore>((set, get) => {
  const poll = async (id: string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    const cur = get().current;
    if (!cur || cur.info.id !== id) return;
    try {
      const after = cur.logs.at(-1)?.n ?? 0;
      const next = await apiGet<BacktestPayload>(`/api/backtests/${id}?logs_after=${after}`);
      if (get().current?.info.id !== id) return;
      if (isActive(next.info)) {
        const logs: BacktestLog[] = [...cur.logs, ...next.logs].slice(-MAX_LOGS);
        set({ current: { ...next, logs } });
        timer = setTimeout(() => void poll(id), POLL_MS);
      } else {
        set({ current: await apiGet<BacktestPayload>(`/api/backtests/${id}`) });
        void get().refreshHistory(next.info.script);
      }
    } catch (e) {
      set({ error: (e as Error).message });
      timer = setTimeout(() => void poll(id), POLL_MS * 3);
    }
  };

  return {
    saved: {},
    hydrated: false,
    current: null,
    history: [],
    error: null,
    starting: false,

    hydrate: () => {
      if (!get().hydrated) set({ saved: loadSaved(), hydrated: true });
    },

    settingsFor: (script, fallback) => get().saved[script] ?? fallback,

    setSettings: (script, settings) => {
      const saved = { ...get().saved, [script]: settings };
      persist(saved);
      set({ saved });
    },

    start: async (script, settings) => {
      set({ starting: true, error: null });
      try {
        const info = await apiPost<BacktestInfo>("/api/backtests", { script, ...settings });
        set({ current: { info, logs: [], log_count: 0, result: null, code: null } });
        void get().refreshHistory(script);
        void poll(info.id);
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ starting: false });
      }
    },

    open: async (id) => {
      set({ error: null });
      try {
        const payload = await apiGet<BacktestPayload>(`/api/backtests/${id}`);
        set({ current: payload });
        if (isActive(payload.info)) void poll(id);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    cancel: async () => {
      const cur = get().current;
      if (!cur) return;
      try {
        await apiPost(`/api/backtests/${cur.info.id}/cancel`);
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    remove: async (id) => {
      try {
        await apiDelete(`/api/backtests/${id}`);
        if (get().current?.info.id === id) set({ current: null });
        set({ history: get().history.filter((h) => h.id !== id) });
      } catch (e) {
        set({ error: (e as Error).message });
      }
    },

    refreshHistory: async (script) => {
      try {
        set({ history: await apiGet<BacktestInfo[]>(`/api/backtests?script=${encodeURIComponent(script)}`) });
      } catch {}
    },

    clear: () => {
      if (timer) clearTimeout(timer);
      set({ current: null, error: null });
    },
  };
});
