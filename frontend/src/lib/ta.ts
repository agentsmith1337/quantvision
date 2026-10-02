// Small technical-analysis toolkit for the Technical Metrics panel. Each function
// returns the value for the latest bar (or null while there isn't enough data),
// using the standard definitions (Wilder smoothing for RSI/ATR, as pandas-ta does).

export type OHLCV = { time: number; open: number; high: number; low: number; close: number; volume: number };

function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev: number | null = null;
  values.forEach((v, i) => {
    if (i < period - 1) {
      out.push(NaN);
      return;
    }
    if (prev === null) prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else prev = v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

const last = (xs: number[]) => {
  const v = xs.at(-1);
  return v === undefined || Number.isNaN(v) ? null : v;
};

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  return values.length < period ? null : last(emaSeries(values, period));
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): { macd: number; signal: number; histogram: number } | null {
  if (values.length < slow + signal) return null;
  const f = emaSeries(values, fast);
  const s = emaSeries(values, slow);
  const line = values.map((_, i) => f[i] - s[i]).filter((v) => !Number.isNaN(v));
  const sig = last(emaSeries(line, signal));
  const m = line.at(-1);
  if (sig === null || m === undefined) return null;
  return { macd: m, signal: sig, histogram: m - sig };
}

export function bbands(values: number[], period = 20, mult = 2): { upper: number; middle: number; lower: number } | null {
  const mid = sma(values, period);
  if (mid === null) return null;
  const win = values.slice(-period);
  const sd = Math.sqrt(win.reduce((a, v) => a + (v - mid) ** 2, 0) / period);
  return { upper: mid + mult * sd, middle: mid, lower: mid - mult * sd };
}

export function atr(bars: OHLCV[], period = 14): number | null {
  if (bars.length <= period) return null;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  let value = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return value;
}

export function stoch(bars: OHLCV[], k = 14, d = 3, smoothK = 3): { k: number; d: number } | null {
  if (bars.length < k + smoothK + d) return null;
  const raw = bars.map((_, i) => {
    if (i < k - 1) return NaN;
    const win = bars.slice(i - k + 1, i + 1);
    const hi = Math.max(...win.map((b) => b.high));
    const lo = Math.min(...win.map((b) => b.low));
    return hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
  }).filter((v) => !Number.isNaN(v));
  const smooth = raw.map((_, i) => (i < smoothK - 1 ? NaN : raw.slice(i - smoothK + 1, i + 1).reduce((a, b) => a + b, 0) / smoothK)).filter((v) => !Number.isNaN(v));
  const kv = smooth.at(-1);
  const dv = sma(smooth, d);
  return kv === undefined || dv === null ? null : { k: kv, d: dv };
}

/** VWAP of the latest trading day in `bars` (IST day boundary). */
export function vwap(bars: OHLCV[]): number | null {
  if (!bars.length) return null;
  const day = (t: number) => Math.floor((t + 19800) / 86400);
  const today = day(bars[bars.length - 1].time);
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (day(b.time) !== today) continue;
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  return vol > 0 ? pv / vol : null;
}
