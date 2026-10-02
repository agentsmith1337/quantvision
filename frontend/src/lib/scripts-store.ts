"use client";

// Global script state (Zustand): the open script is shared by the Trading
// Dashboard's quick editor and the Studio, so edits in one show in the other.
// Runs and their logs are kept fresh from the engine's WebSocket events.

import { create } from "zustand";
import { apiDelete, apiGet, apiPost, apiPut, type LogEntry, type RunInfo, type ScriptDefaults, type ScriptFile, type ScriptInfo } from "./api";
import type { ScriptEvent } from "./market-socket";

const MAX_LOG_LINES = 2000;
const LAST_SCRIPT_KEY = "qv.scripts.last";

type ScriptsState = {
  scripts: ScriptInfo[];
  current: string | null;
  content: string;
  saved: string;
  defaults: ScriptDefaults | null;
  syntaxError: string | null;
  loading: boolean;
  error: string | null;

  runs: RunInfo[];
  logs: Record<string, LogEntry[]>;

  refreshScripts: () => Promise<void>;
  open: (name: string) => Promise<void>;
  openInitial: () => Promise<void>;
  setContent: (content: string) => void;
  save: () => Promise<boolean>;
  create: (name: string, content?: string) => Promise<void>;
  rename: (newName: string) => Promise<void>;
  remove: () => Promise<void>;

  refreshRuns: () => Promise<void>;
  loadLogs: (runId: string) => Promise<void>;
  applyEvent: (event: ScriptEvent) => void;
};

const NEW_SCRIPT = `"""My strategy."""

SYMBOLS = ["RELIANCE"]
INTERVAL = "5m"


def on_candle(candle, indicators, api):
    sma_20 = indicators.sma(period=20)
    if sma_20 is None:
        return

    if candle.close > sma_20 and api.position() == 0:
        api.buy(quantity=1)
    elif candle.close < sma_20 and api.position() > 0:
        api.sell(quantity=api.position())
`;

function remember(name: string | null) {
  try {
    if (name) localStorage.setItem(LAST_SCRIPT_KEY, name);
  } catch {}
}

export const useScripts = create<ScriptsState>((set, get) => ({
  scripts: [],
  current: null,
  content: "",
  saved: "",
  defaults: null,
  syntaxError: null,
  loading: false,
  error: null,
  runs: [],
  logs: {},

  refreshScripts: async () => {
    try {
      set({ scripts: await apiGet<ScriptInfo[]>("/api/scripts") });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  open: async (name) => {
    const { current, content, saved } = get();
    if (current && content !== saved) await get().save();
    set({ loading: true, error: null });
    try {
      const file = await apiGet<ScriptFile>(`/api/scripts/${encodeURIComponent(name)}`);
      set({ current: name, content: file.content, saved: file.content, defaults: file.defaults, syntaxError: file.syntax_error, loading: false });
      remember(name);
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  openInitial: async () => {
    if (get().current) return;
    await get().refreshScripts();
    const names = get().scripts.map((s) => s.name);
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_SCRIPT_KEY);
    } catch {}
    const pick = last && names.includes(last) ? last : names[0];
    if (pick) await get().open(pick);
  },

  setContent: (content) => set({ content }),

  save: async () => {
    const { current, content } = get();
    if (!current) return false;
    try {
      const r = await apiPut<{ defaults: ScriptDefaults; syntax_error: string | null }>(`/api/scripts/${encodeURIComponent(current)}`, { content });
      set({ saved: content, defaults: r.defaults, syntaxError: r.syntax_error, error: null });
      void get().refreshScripts();
      return true;
    } catch (e) {
      set({ error: (e as Error).message });
      return false;
    }
  },

  create: async (name, content = NEW_SCRIPT) => {
    const file = name.endsWith(".py") ? name : `${name}.py`;
    await apiPut(`/api/scripts/${encodeURIComponent(file)}`, { content });
    await get().refreshScripts();
    await get().open(file);
  },

  rename: async (newName) => {
    const { current } = get();
    if (!current) return;
    const file = newName.endsWith(".py") ? newName : `${newName}.py`;
    if (get().content !== get().saved) await get().save();
    await apiPost(`/api/scripts/${encodeURIComponent(current)}/rename`, { new_name: file });
    set({ current: file });
    remember(file);
    await get().refreshScripts();
  },

  remove: async () => {
    const { current } = get();
    if (!current) return;
    await apiDelete(`/api/scripts/${encodeURIComponent(current)}`);
    set({ current: null, content: "", saved: "", defaults: null, syntaxError: null });
    await get().refreshScripts();
    const next = get().scripts[0];
    if (next) await get().open(next.name);
  },

  refreshRuns: async () => {
    try {
      set({ runs: await apiGet<RunInfo[]>("/api/runs") });
    } catch {}
  },

  loadLogs: async (runId) => {
    try {
      const entries = await apiGet<LogEntry[]>(`/api/runs/${runId}/logs`);
      set((s) => ({ logs: { ...s.logs, [runId]: mergeLogs(s.logs[runId] ?? [], entries) } }));
    } catch {}
  },

  applyEvent: (event) => {
    if (event.kind === "run") {
      set((s) => {
        const others = s.runs.filter((r) => r.id !== event.run.id);
        return { runs: [event.run, ...others].sort((a, b) => b.started_at.localeCompare(a.started_at)) };
      });
    } else {
      set((s) => ({ logs: { ...s.logs, [event.runId]: mergeLogs(s.logs[event.runId] ?? [], [event.entry]) } }));
    }
  },
}));

// Live lines can arrive before the fetched history, so merge by sequence number.
function mergeLogs(existing: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const last = existing.at(-1)?.seq ?? 0;
  if (incoming.every((e) => e.seq > last)) {
    const merged = existing.concat(incoming);
    return merged.length > MAX_LOG_LINES ? merged.slice(-MAX_LOG_LINES) : merged;
  }
  const bySeq = new Map(existing.map((e) => [e.seq, e]));
  incoming.forEach((e) => bySeq.set(e.seq, e));
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-MAX_LOG_LINES);
}

export const isDirty = (s: Pick<ScriptsState, "content" | "saved" | "current">) => s.current !== null && s.content !== s.saved;
