"use client";

import Link from "next/link";
import { useState } from "react";
import { apiGet, type Candle, type Interval, type NewsPayload } from "@/lib/api";
import { changeColor, formatPrice } from "@/lib/format";
import { useTick } from "@/lib/market-socket";
import * as ta from "@/lib/ta";
import { useApi } from "@/lib/use-api";

const HISTORY_DAYS: Record<Interval, number> = { "1m": 2, "5m": 10, "15m": 30, "1h": 90, "1d": 730 };

/** Tri-mode panel under the chart: Technical Metrics, Live News, AI Analysis (Phase 6). */
export function AnalysisPanel({ symbol, interval }: { symbol: string; interval: Interval }) {
  const [mode, setMode] = useState<"metrics" | "news" | "ai">("metrics");
  const tab = (id: typeof mode, label: string) => (
    <button
      onClick={() => setMode(id)}
      className={`border-b-2 px-1 pb-2 text-sm ${mode === id ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-4 border-b border-border px-4 pt-2">
        {tab("metrics", "Technical metrics")}
        {tab("news", "Live news")}
        {tab("ai", "AI analysis")}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "metrics" && <TechnicalMetrics symbol={symbol} interval={interval} />}
        {mode === "news" && <NewsFeed symbol={symbol} />}
        {mode === "ai" && <p className="p-4 text-sm text-muted">AI sentiment analysis of the news feed arrives in Phase 6.</p>}
      </div>
    </div>
  );
}

// --- Technical metrics ------------------------------------------------------------------

type Reading = { label: string; value: string; note: string; tone?: "up" | "down" | "muted" };

function TechnicalMetrics({ symbol, interval }: { symbol: string; interval: Interval }) {
  const tick = useTick(symbol);
  const { data, error } = useApi<{ candles: Candle[] }>(`/api/market/candles/${encodeURIComponent(symbol)}?interval=${interval}&days=${HISTORY_DAYS[interval]}`, { intervalMs: 60_000 });
  if (error) return <p className="p-4 text-xs text-down">{error}</p>;
  if (!data) return <p className="p-4 text-xs text-muted">Calculating…</p>;

  const bars: ta.OHLCV[] = data.candles;
  const closes = bars.map((b) => b.close);
  const price = tick?.ltp ?? closes.at(-1) ?? null;
  const fmt = (v: number | null, digits = 2) => (v === null ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  const vsPrice = (v: number | null): Pick<Reading, "note" | "tone"> =>
    v === null || price === null ? { note: "not enough data", tone: "muted" } : price >= v ? { note: "price above", tone: "up" } : { note: "price below", tone: "down" };

  const rsi = ta.rsi(closes);
  const macd = ta.macd(closes);
  const bb = ta.bbands(closes);
  const st = ta.stoch(bars);
  const atr = ta.atr(bars);
  const vwap = ta.vwap(bars);
  const sma20 = ta.sma(closes, 20);
  const ema50 = ta.ema(closes, 50);
  const sma200 = ta.sma(closes, 200);

  const readings: Reading[] = [
    { label: "RSI (14)", value: fmt(rsi, 1), ...(rsi === null ? { note: "—", tone: "muted" } : rsi > 70 ? { note: "overbought", tone: "down" } : rsi < 30 ? { note: "oversold", tone: "up" } : { note: "neutral", tone: "muted" }) },
    {
      label: "MACD (12, 26, 9)",
      value: macd ? `${fmt(macd.macd)} / ${fmt(macd.signal)}` : "—",
      ...(macd === null ? { note: "—", tone: "muted" } : macd.histogram >= 0 ? { note: "bullish (above signal)", tone: "up" } : { note: "bearish (below signal)", tone: "down" }),
    },
    {
      label: "Stochastic (14, 3, 3)",
      value: st ? `${fmt(st.k, 1)} / ${fmt(st.d, 1)}` : "—",
      ...(st === null ? { note: "—", tone: "muted" } : st.k > 80 ? { note: "overbought", tone: "down" } : st.k < 20 ? { note: "oversold", tone: "up" } : { note: "neutral", tone: "muted" }),
    },
    { label: "SMA 20", value: fmt(sma20), ...vsPrice(sma20) },
    { label: "EMA 50", value: fmt(ema50), ...vsPrice(ema50) },
    { label: "SMA 200", value: fmt(sma200), ...vsPrice(sma200) },
    {
      label: "Bollinger (20, 2)",
      value: bb ? `${fmt(bb.lower)} – ${fmt(bb.upper)}` : "—",
      ...(bb === null || price === null ? { note: "—", tone: "muted" } : price > bb.upper ? { note: "above upper band", tone: "down" } : price < bb.lower ? { note: "below lower band", tone: "up" } : { note: "inside bands", tone: "muted" }),
    },
    { label: "ATR (14)", value: fmt(atr), note: atr && price ? `${((atr / price) * 100).toFixed(2)}% of price per bar` : "—", tone: "muted" },
    { label: "VWAP (today)", value: fmt(vwap), ...vsPrice(vwap) },
  ];

  const market: [string, string][] = [
    ["LTP", formatPrice(price)],
    ["Day open / high / low", tick ? `${formatPrice(tick.open)} / ${formatPrice(tick.high)} / ${formatPrice(tick.low)}` : "—"],
    ["Prev close", formatPrice(tick?.prev_close)],
    ["Day volume", tick?.volume != null ? tick.volume.toLocaleString("en-IN") : "—"],
  ];

  return (
    <div className="grid gap-x-8 gap-y-1 p-4 text-xs md:grid-cols-[2fr_1fr]">
      <table className="w-full">
        <tbody>
          {readings.map((r) => (
            <tr key={r.label} className="border-b border-border/60 last:border-0">
              <td className="py-1.5 pr-3 text-muted">{r.label}</td>
              <td className="py-1.5 pr-3 text-right font-mono tabular-nums">{r.value}</td>
              <td className={`py-1.5 ${r.tone === "up" ? "text-up" : r.tone === "down" ? "text-down" : "text-muted"}`}>{r.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="space-y-1.5 self-start">
        {market.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className={`font-mono tabular-nums ${k === "LTP" ? changeColor(tick?.change) : ""}`}>{v}</dd>
          </div>
        ))}
        <p className="pt-2 text-[11px] text-muted">On {interval} candles. Readings are context, not advice.</p>
      </dl>
    </div>
  );
}

// --- News ------------------------------------------------------------------------------------

const ago = (iso: string | null) => {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

function NewsFeed({ symbol }: { symbol: string }) {
  const [refreshing, setRefreshing] = useState(false);
  const [override, setOverride] = useState<NewsPayload | null>(null);
  const { data, error } = useApi<NewsPayload>(`/api/news/${encodeURIComponent(symbol)}`, { intervalMs: 10 * 60_000 });
  const news = override?.symbol === symbol ? override : data;

  const refresh = async () => {
    setRefreshing(true);
    try {
      setOverride(await apiGet<NewsPayload>(`/api/news/${encodeURIComponent(symbol)}?refresh=true`));
    } catch {
      /* the error shows via the next load */
    } finally {
      setRefreshing(false);
    }
  };

  if (error) return <p className="p-4 text-xs text-down">{error}</p>;
  if (!news) return <p className="p-4 text-xs text-muted">Loading news…</p>;
  if (!news.configured) {
    return (
      <div className="p-4 text-sm text-muted">
        Add a GNews API key in{" "}
        <Link href="/setup/#news" className="text-accent underline">
          Settings → News
        </Link>{" "}
        to see live news for {symbol}. The free plan at gnews.io allows 100 requests a day.
      </div>
    );
  }
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5 text-[11px] text-muted">
        <span className="truncate" title="GNews search query">
          {news.query}
        </span>
        <span className="ml-auto shrink-0">
          {news.usage.today}/{news.usage.limit} requests today
        </span>
        <button onClick={() => void refresh()} disabled={refreshing} className="shrink-0 text-accent hover:underline disabled:opacity-50">
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {news.articles.length === 0 ? (
        <p className="p-4 text-xs text-muted">No recent articles found.</p>
      ) : (
        <ul className="divide-y divide-border">
          {news.articles.map((a) => (
            <li key={a.url}>
              <a href={a.url} target="_blank" rel="noreferrer noopener" className="flex gap-3 px-4 py-2.5 hover:bg-surface-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {a.image && <img src={a.image} alt="" referrerPolicy="no-referrer" className="hidden size-14 shrink-0 rounded-md object-cover sm:block" />}
                <div className="min-w-0">
                  <div className="text-sm font-medium leading-snug">{a.title}</div>
                  {a.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{a.description}</div>}
                  <div className="mt-1 text-[11px] text-muted">
                    {a.source} · {ago(a.published_at)}
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
