// Chart types, indicators and drawing tools offered by the price chart. Kept free of
// react-financial-charts imports so menus can use it without loading the chart.

export type ChartType = "candles" | "heikin-ashi" | "bars" | "line" | "area" | "renko" | "kagi" | "point-figure";

export const CHART_TYPES: { id: ChartType; label: string; hint?: string }[] = [
  { id: "candles", label: "Candles" },
  { id: "heikin-ashi", label: "Heikin-Ashi" },
  { id: "bars", label: "OHLC bars" },
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "renko", label: "Renko", hint: "Bricks on fixed price moves (ATR-sized); time is ignored" },
  { id: "kagi", label: "Kagi", hint: "Line that only reverses on a meaningful move" },
  { id: "point-figure", label: "Point & Figure", hint: "X/O columns, box = 1/40 of the price range, 3-box reversal" },
];

/** Price-movement charts: no time axis, so indicators and drawings don't apply. */
export const BRICK_CHARTS: ReadonlySet<ChartType> = new Set<ChartType>(["renko", "kagi", "point-figure"]);

export type OverlayId = "ema20" | "ema50" | "sma200" | "wma20" | "tma20" | "bollinger" | "sar" | "volume" | "volume-profile" | "elder-impulse";
export type PaneId = "rsi" | "macd" | "stoch-slow" | "stoch-fast" | "stoch-full" | "atr" | "elder-ray" | "force-index" | "compare";
export type IndicatorId = OverlayId | PaneId;

export const INDICATOR_GROUPS: { title: string; items: { id: IndicatorId; label: string; hint: string }[] }[] = [
  {
    title: "On the price chart",
    items: [
      { id: "ema20", label: "EMA 20", hint: "Exponential moving average, 20 bars" },
      { id: "ema50", label: "EMA 50", hint: "Exponential moving average, 50 bars" },
      { id: "sma200", label: "SMA 200", hint: "Simple moving average, 200 bars" },
      { id: "wma20", label: "WMA 20", hint: "Weighted moving average, 20 bars" },
      { id: "tma20", label: "TMA 20", hint: "Triangular moving average, 20 bars" },
      { id: "bollinger", label: "Bollinger Bands", hint: "20-bar SMA ± 2 standard deviations" },
      { id: "sar", label: "Parabolic SAR", hint: "Trailing stop-and-reverse dots (0.02 / 0.2)" },
      { id: "volume", label: "Volume", hint: "Volume bars under the price" },
      { id: "volume-profile", label: "Volume Profile", hint: "Volume traded at each price level" },
      { id: "elder-impulse", label: "Elder Impulse", hint: "Colours candles by EMA-13 and MACD momentum (blue = neutral)" },
    ],
  },
  {
    title: "In their own pane",
    items: [
      { id: "rsi", label: "RSI 14", hint: "Relative Strength Index with 30/70 bands" },
      { id: "macd", label: "MACD 12/26/9", hint: "Moving average convergence/divergence" },
      { id: "stoch-slow", label: "Stochastic (slow)", hint: "14-bar, %K smoothed 3, %D 3" },
      { id: "stoch-fast", label: "Stochastic (fast)", hint: "14-bar, raw %K, %D 3" },
      { id: "stoch-full", label: "Stochastic (full)", hint: "14-bar, %K smoothed 3, %D 4" },
      { id: "atr", label: "ATR 14", hint: "Average True Range: volatility in rupees" },
      { id: "elder-ray", label: "Elder Ray", hint: "Bull and bear power around EMA-13" },
      { id: "force-index", label: "Force Index", hint: "Price change × volume, smoothed with EMA-13" },
      { id: "compare", label: "Compare vs index", hint: "% change against NIFTY (SENSEX when viewing NIFTY)" },
    ],
  },
];

export const PANE_ORDER: PaneId[] = ["rsi", "macd", "stoch-slow", "stoch-fast", "stoch-full", "atr", "elder-ray", "force-index", "compare"];

export const INDICATOR_LABELS: Record<IndicatorId, string> = Object.fromEntries(
  INDICATOR_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i.label])),
) as Record<IndicatorId, string>;

export type DrawingTool = "cursor" | "trendline" | "ray" | "fibonacci" | "channel" | "stddev" | "gann" | "text" | "hline";

/** Benchmark for the "Compare" pane. */
export function benchmarkFor(symbol: string): string {
  return symbol === "NIFTY" ? "SENSEX" : "NIFTY";
}
