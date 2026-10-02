"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
  // No inner scrollbar: the panel grows with its content and the page scrolls.
  return (
    <div>
      <div className="flex gap-4 border-b border-border px-4 pt-2">
        {tab("metrics", "Technical metrics")}
        {tab("news", "Live news")}
        {tab("ai", "AI analysis")}
      </div>
      <div className="min-h-40">
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

/** Editable GNews query; starts with the query the results came from. */
function NewsQuery({ initial, custom, onSearch }: { initial: string; custom: boolean; onSearch: (q: string) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <form
      className="flex min-w-64 flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const q = draft.trim();
        if (q && q !== initial) onSearch(q);
      }}
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={200}
        aria-label="News search query"
        title='GNews search: use quotes for phrases, OR / AND / NOT to combine, e.g. "Tata Motors" AND EV'
        className="min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent"
      />
      <button type="submit" disabled={!draft.trim() || draft.trim() === initial} className="shrink-0 rounded-md bg-accent px-2 py-1 font-medium text-accent-fg disabled:opacity-40">
        Search
      </button>
      {custom && (
        <button type="button" onClick={() => onSearch("")} className="shrink-0 text-accent hover:underline">
          Reset
        </button>
      )}
    </form>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${Math.max(mins, 1)}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

const newsPath = (symbol: string, query: string, refresh = false) => {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (refresh) params.set("refresh", "true");
  const qs = params.toString();
  return `/api/news/${encodeURIComponent(symbol)}${qs ? `?${qs}` : ""}`;
};

function NewsFeed({ symbol }: { symbol: string }) {
  // The user's own search per stock ("" = the default company/symbol search).
  const [queries, setQueries] = useState<Record<string, string>>({});
  const query = queries[symbol] ?? "";
  const [fullScreen, setFullScreen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [override, setOverride] = useState<{ key: string; payload: NewsPayload } | null>(null);
  const path = newsPath(symbol, query);
  const { data, error } = useApi<NewsPayload>(path, { intervalMs: 10 * 60_000 });
  const news = override?.key === path ? override.payload : data;
  const setQuery = (q: string) => setQueries((all) => ({ ...all, [symbol]: q }));

  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFullScreen(false);
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [fullScreen]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      setOverride({ key: path, payload: await apiGet<NewsPayload>(newsPath(symbol, query, true)) });
    } catch {
      /* the error shows via the next load */
    } finally {
      setRefreshing(false);
    }
  };

  const body = (
    <NewsBody
      symbol={symbol}
      news={news}
      error={error}
      query={query}
      onSearch={setQuery}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      fullScreen={fullScreen}
      onToggleFullScreen={() => setFullScreen((f) => !f)}
    />
  );
  if (!fullScreen) return body;
  return (
    <>
      <p className="p-4 text-xs text-muted">News is open in full screen.</p>
      <div role="dialog" aria-modal="true" aria-label={`News for ${symbol}`} className="fixed inset-0 z-50 overflow-y-auto bg-bg">
        <div className="mx-auto max-w-4xl py-6">
          <h2 className="px-4 pb-3 text-lg font-semibold">News · {symbol}</h2>
          <div className="rounded-xl border border-border bg-surface">{body}</div>
        </div>
      </div>
    </>
  );
}

function NewsBody({
  symbol,
  news,
  error,
  query,
  onSearch,
  refreshing,
  onRefresh,
  fullScreen,
  onToggleFullScreen,
}: {
  symbol: string;
  news: NewsPayload | null;
  error: string | null;
  query: string;
  onSearch: (q: string) => void;
  refreshing: boolean;
  onRefresh: () => void;
  fullScreen: boolean;
  onToggleFullScreen: () => void;
}) {
  if (error && !news) {
    return (
      <div className="space-y-2 p-4 text-xs">
        <p className="text-down">{error}</p>
        {query && (
          <button onClick={() => onSearch("")} className="text-accent hover:underline">
            Back to the default search
          </button>
        )}
      </div>
    );
  }
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2 text-[11px] text-muted">
        <NewsQuery key={`${symbol}:${news.query}`} initial={news.query ?? ""} custom={!!query} onSearch={onSearch} />
        <span className="ml-auto shrink-0">
          {news.usage.today}/{news.usage.limit} requests today
        </span>
        <button onClick={onRefresh} disabled={refreshing} className="shrink-0 text-accent hover:underline disabled:opacity-50">
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <button onClick={onToggleFullScreen} className="shrink-0 rounded-md border border-border px-2 py-0.5 text-fg hover:bg-surface-2" title={fullScreen ? "Close (Esc)" : "Expand to full screen"}>
          {fullScreen ? "Close ✕" : "⤢ Full screen"}
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
