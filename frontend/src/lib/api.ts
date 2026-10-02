// In production the UI is served by FastAPI itself, so the API is same-origin.
// `next dev` runs on localhost:3000; the API must also be on "localhost" (not
// 127.0.0.1) so the SameSite=Strict session cookie counts as same-site.
export const API_BASE = process.env.NODE_ENV === "development" ? "http://localhost:8000" : "";

export function wsUrl(path: string): string {
  if (API_BASE) return API_BASE.replace(/^http/, "ws") + path;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Fired when the backend says the session is gone; the auth gate listens for it. */
export const UNAUTHORIZED_EVENT = "qv:unauthorized";

// --- In-flight tracking (drives the top progress bar) --------------------------

let inflight = 0;
const inflightListeners = new Set<() => void>();
const setInflight = (n: number) => {
  inflight = n;
  inflightListeners.forEach((cb) => cb());
};
export const inflightStore = {
  get: () => inflight,
  subscribe: (cb: () => void) => {
    inflightListeners.add(cb);
    return () => inflightListeners.delete(cb);
  },
};

export type RequestOptions = {
  signal?: AbortSignal;
  /** Background refreshes don't show the progress bar. */
  background?: boolean;
};

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "include", signal: opts.signal };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }
  if (!opts.background) setInflight(inflight + 1);
  try {
    const res = await fetch(API_BASE + path, init);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      let message = `${res.status} ${res.statusText}`;
      if (typeof data?.detail === "string") message = data.detail;
      else if (Array.isArray(data?.detail) && data.detail[0]?.msg) message = String(data.detail[0].msg).replace(/^Value error, /, "");
      if (res.status === 401 && !path.startsWith("/api/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as T;
  } finally {
    if (!opts.background) setInflight(inflight - 1);
  }
}

export const apiGet = <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts);
export const apiPost = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});
export const apiPut = <T>(path: string, body: unknown) => request<T>("PUT", path, body);
export const apiPatch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const apiDelete = <T>(path: string) => request<T>("DELETE", path);

/** Errors worth retrying automatically: Angel One rate limits and transient upstream failures. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof ApiError)) return !isAbortError(e); // network blip
  return e.status === 429 || e.status === 502 || e.status === 503 || (e.status === 400 && /rate-limit|access rate/i.test(e.message));
}

export type Instrument = {
  symbol: string;
  name: string;
  exchange: string;
  is_index: boolean;
};

export type Candle = {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Interval = "1m" | "5m" | "15m" | "1h" | "1d";

export const INTERVAL_SECONDS: Record<Interval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "1d": 86400,
};

// --- Trading -------------------------------------------------------------------

export type TradingMode = "paper" | "live";
export type Side = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type Product = "DELIVERY" | "INTRADAY";

export type Order = {
  order_id: string;
  symbol: string;
  side: Side;
  order_type: OrderType;
  product: string;
  validity: string;
  quantity: number;
  filled_quantity: number;
  price: number | null;
  trigger_price: number | null;
  average_price: number | null;
  status: string;
  message: string;
  updated_at: string;
  is_open: boolean;
  source?: string; // "manual" or the tag of the script run that placed it
};

export type Trade = { trade_id: string; order_id: string; symbol: string; side: Side; product: string; quantity: number; price: number; time: string };
export type Holding = { symbol: string; exchange: string; quantity: number; average_price: number; ltp: number | null; close: number | null };
export type Position = {
  symbol: string;
  product: string;
  net_quantity: number;
  buy_quantity: number;
  sell_quantity: number;
  buy_average: number;
  sell_average: number;
  ltp: number | null;
  realised_pnl: number;
};
export type Funds = { available_cash: number; used_margin: number; net: number };

export type BrokerStatus = {
  trading_mode: TradingMode;
  live_available: boolean;
  credentials: { api_key: string; client_code: string } | null;
  env_credentials_available: boolean;
  simulated_only: boolean;
};

export type Prefs = {
  watchlist: string[];
  trading_mode: TradingMode;
  risk: { max_order_value: number; max_orders_per_minute: number };
  static_ips: { primary: string; secondary: string };
  features: { confirm_orders: boolean; execution_popups: boolean };
};

// --- Scripts ---------------------------------------------------------------------

export type ScriptInfo = { name: string; size: number; modified: string };
export type ScriptDefaults = { symbols: string[] | null; interval: Interval | null; has_on_candle: boolean };
export type ScriptFile = { name: string; content: string; defaults: ScriptDefaults; syntax_error: string | null };
export type RuntimeStatus = { state: "unknown" | "missing" | "installing" | "ready" | "error"; message: string; path: string };

export type RunState = "starting" | "running" | "stopping" | "stopped" | "finished" | "failed";
export type RunInfo = {
  id: string;
  script: string;
  symbols: string[];
  interval: Interval;
  state: RunState;
  message: string;
  started_at: string;
  ended_at: string | null;
  candles: number;
  orders: number;
  errors: number;
  tag: string;
  active: boolean;
};
export type LogEntry = { seq: number; ts: number; level: "info" | "warning" | "error"; text: string };

// --- News ------------------------------------------------------------------------

export type NewsArticle = { title: string; description: string; url: string; image: string | null; published_at: string | null; source: string };
export type NewsPayload = {
  symbol: string;
  configured: boolean;
  query?: string;
  fetched_at?: string;
  cached?: boolean;
  articles: NewsArticle[];
  usage: { today: number; limit: number };
};
