"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { wsUrl, type Order, type TradingMode } from "./api";

export type Tick = {
  symbol: string;
  ltp: number;
  ts: number; // epoch milliseconds
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  change?: number;
  change_pct?: number;
};

export type FeedStatus = {
  mode: "angelone" | "simulated" | "none";
  state: "locked" | "connecting" | "connected" | "disconnected" | "error";
  message: string;
};

export type OrderEvent = { broker: TradingMode; order: Order };

type TickListener = (tick: Tick) => void;
type OrderListener = (event: OrderEvent) => void;

/**
 * One shared WebSocket to the local backend (/ws/market), authenticated by the
 * session cookie. Components subscribe per symbol; the socket subscribes
 * upstream to the union, carries order updates, and reconnects on loss.
 */
class MarketSocket {
  private ws: WebSocket | null = null;
  private enabled = false;
  private listeners = new Map<string, Set<TickListener>>();
  private orderListeners = new Set<OrderListener>();
  private statusListeners = new Set<() => void>();
  private ticks = new Map<string, Tick>();
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  status: FeedStatus | null = null;

  /** Connect only while signed in; toggling reconnects with the current cookie. */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
    this.ticks.clear();
    if (enabled) this.ensureOpen();
  }

  private ensureOpen() {
    if (this.ws || !this.enabled || typeof window === "undefined") return;
    const ws = new WebSocket(wsUrl("/ws/market"));
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 1000;
      this.setConnected(true);
      const symbols = [...this.listeners.keys()];
      if (symbols.length) ws.send(JSON.stringify({ op: "subscribe", symbols }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "tick") {
        this.ticks.set(msg.symbol, msg);
        this.listeners.get(msg.symbol)?.forEach((cb) => cb(msg));
      } else if (msg.type === "status") {
        this.status = { mode: msg.mode, state: msg.state, message: msg.message };
        this.statusListeners.forEach((cb) => cb());
      } else if (msg.type === "order") {
        this.orderListeners.forEach((cb) => cb({ broker: msg.broker, order: msg.order }));
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // replaced by setEnabled
      this.ws = null;
      this.setConnected(false);
      if (this.enabled) {
        this.retryTimer = setTimeout(() => this.ensureOpen(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 10_000);
      }
    };
  }

  private setConnected(value: boolean) {
    this.connected = value;
    this.statusListeners.forEach((cb) => cb());
  }

  private send(op: "subscribe" | "unsubscribe", symbol: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, symbols: [symbol] }));
    }
  }

  subscribe(symbol: string, cb: TickListener): () => void {
    let set = this.listeners.get(symbol);
    if (!set) {
      set = new Set();
      this.listeners.set(symbol, set);
      this.send("subscribe", symbol);
    }
    set.add(cb);
    this.ensureOpen();
    return () => {
      set.delete(cb);
      if (set.size === 0) {
        this.listeners.delete(symbol);
        this.send("unsubscribe", symbol);
      }
    };
  }

  subscribeOrders(cb: OrderListener): () => void {
    this.orderListeners.add(cb);
    this.ensureOpen();
    return () => this.orderListeners.delete(cb);
  }

  lastTick(symbol: string): Tick | undefined {
    return this.ticks.get(symbol);
  }

  subscribeStatus(cb: () => void): () => void {
    this.statusListeners.add(cb);
    this.ensureOpen();
    return () => this.statusListeners.delete(cb);
  }

  get isConnected() {
    return this.connected;
  }
}

export const marketSocket = new MarketSocket();

/** Latest tick for a symbol; re-renders on every tick. */
export function useTick(symbol: string): Tick | undefined {
  return useSyncExternalStore(
    (cb) => marketSocket.subscribe(symbol, cb),
    () => marketSocket.lastTick(symbol),
    () => undefined,
  );
}

/** Upstream feed status, or null while the local backend is unreachable. */
export function useFeedStatus(): FeedStatus | null {
  return useSyncExternalStore(
    (cb) => marketSocket.subscribeStatus(cb),
    () => (marketSocket.isConnected ? marketSocket.status : null),
    () => null,
  );
}

/** Run `cb` for every order update pushed by the engine. */
export function useOrderEvents(cb: OrderListener) {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  });
  useEffect(() => marketSocket.subscribeOrders((e) => ref.current(e)), []);
}
