"use client";

// Canvas chart built on react-financial-charts. Client-only: loaded through
// next/dynamic with ssr disabled by price-chart.tsx.

import { useMemo } from "react";
import {
  AreaSeries,
  BarSeries,
  BollingerBandTooltip,
  BollingerSeries,
  CandlestickSeries,
  Chart,
  ChartCanvas,
  ClickCallback,
  CrossHairCursor,
  CurrentCoordinate,
  EdgeIndicator,
  ElderRaySeries,
  EquidistantChannel,
  FibonacciRetracement,
  GannFan,
  InteractiveText,
  InteractiveYCoordinate,
  KagiSeries,
  LineSeries,
  MACDSeries,
  MACDTooltip,
  MouseCoordinateX,
  MouseCoordinateY,
  MovingAverageTooltip,
  OHLCSeries,
  OHLCTooltip,
  PointAndFigureSeries,
  RSISeries,
  RSITooltip,
  RenkoSeries,
  SARSeries,
  SingleValueTooltip,
  StandardDeviationChannel,
  StochasticSeries,
  StochasticTooltip,
  StraightLine,
  TrendLine,
  VolumeProfileSeries,
  XAxis,
  YAxis,
  ZoomButtons,
  atr,
  bollingerBand,
  compare,
  discontinuousTimeScaleProviderBuilder,
  elderRay,
  ema,
  forceIndex,
  heikinAshi,
  kagi,
  lastVisibleItemBasedZoomAnchor,
  macd,
  pointAndFigure,
  renko,
  rsi,
  sar,
  sma,
  stochasticOscillator,
  tma,
  wma,
} from "react-financial-charts";
import { withAlpha, type ChartPalette } from "@/lib/chart-theme";
import { BRICK_CHARTS, PANE_ORDER, type ChartType, type DrawingTool, type IndicatorId, type PaneId } from "./catalog";

export type { ChartType, DrawingTool, IndicatorId } from "./catalog";

export type Bar = { date: Date; open: number; high: number; low: number; close: number; volume: number };

// react-financial-charts drawing objects. x values are bar indexes on the chart's scale.
export type XY = [number, number];
export type TrendDrawing = { start: XY; end: XY; type: "LINE" | "RAY" | "XLINE"; selected?: boolean; seq?: number };
export type FibDrawing = { x1: number; y1: number; x2: number; y2: number; type: "EXTEND" | "RAY" | "BOUND"; selected?: boolean; seq?: number };
export type ChannelDrawing = { startXY: XY; endXY: XY; dy: number; selected?: boolean; seq?: number };
export type StdDevDrawing = { start: XY; end: XY; selected?: boolean; seq?: number };
export type FanDrawing = { startXY: XY; endXY: XY; selected?: boolean; seq?: number };
export type TextDrawing = { position: XY; text: string; selected?: boolean; seq?: number };
export type LevelDrawing = { id: string; yValue: number; text: string; selected?: boolean; seq?: number };
export type Drawings = {
  trends: TrendDrawing[];
  fibs: FibDrawing[];
  channels: ChannelDrawing[];
  stddevs: StdDevDrawing[];
  fans: FanDrawing[];
  texts: TextDrawing[];
  levels: LevelDrawing[];
};
export type DrawingKind = keyof Drawings;

type Props = {
  width: number;
  height: number;
  seriesName: string; // changing it resets zoom/pan
  bars: Bar[];
  intraday: boolean;
  chartType: ChartType;
  indicators: ReadonlySet<IndicatorId>;
  /** Benchmark closes by bar timestamp (ms), for the Compare pane. */
  benchmark: { symbol: string; closes: Map<number, number> } | null;
  tool: DrawingTool;
  drawings: Drawings;
  onDrawingsChange: <K extends DrawingKind>(kind: K, items: Drawings[K]) => void;
  /** The text tool picked a spot; the caller asks for the label. */
  onTextPosition: (position: XY) => void;
  onToolDone: () => void;
  palette: ChartPalette;
  fontFamily: string;
};

const MARGIN = { left: 8, right: 72, top: 8, bottom: 28 };

const priceFmt = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 2 });
const formatPrice = (n: number) => priceFmt.format(n);
const formatCompact = (n: number) => compactFmt.format(n);
const formatPct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
const timeFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

// A bar after indicator calculators have merged their outputs onto it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Bar & Record<string, any>;

function makeCalculators(palette: ChartPalette) {
  const [c0, c1, c2, c3] = palette.overlays;
  return {
    ema20: ema().id(1).options({ windowSize: 20 }).merge((d: Row, c: number) => { d.ema20 = c; }).accessor((d: Row) => d.ema20).stroke(c0),
    ema50: ema().id(2).options({ windowSize: 50 }).merge((d: Row, c: number) => { d.ema50 = c; }).accessor((d: Row) => d.ema50).stroke(c1),
    sma200: sma().id(3).options({ windowSize: 200 }).merge((d: Row, c: number) => { d.sma200 = c; }).accessor((d: Row) => d.sma200).stroke(c2),
    wma20: wma().id(4).options({ windowSize: 20 }).merge((d: Row, c: number) => { d.wma20 = c; }).accessor((d: Row) => d.wma20).stroke(c3),
    tma20: tma().id(5).options({ windowSize: 20 }).merge((d: Row, c: number) => { d.tma20 = c; }).accessor((d: Row) => d.tma20).stroke(palette.muted),
    ema13: ema().id(6).options({ windowSize: 13 }).merge((d: Row, c: number) => { d.ema13 = c; }).accessor((d: Row) => d.ema13),
    bollinger: bollingerBand().merge((d: Row, c: unknown) => { d.bb = c; }).accessor((d: Row) => d.bb),
    sar: sar().options({ accelerationFactor: 0.02, maxAccelerationFactor: 0.2 }).merge((d: Row, c: number) => { d.sar = c; }).accessor((d: Row) => d.sar),
    rsi: rsi().options({ windowSize: 14 }).merge((d: Row, c: number) => { d.rsi = c; }).accessor((d: Row) => d.rsi),
    macd: macd().options({ fast: 12, slow: 26, signal: 9 }).merge((d: Row, c: unknown) => { d.macd = c; }).accessor((d: Row) => d.macd),
    "stoch-slow": stochasticOscillator().options({ windowSize: 14, kWindowSize: 3, dWindowSize: 3 }).merge((d: Row, c: unknown) => { d.stoSlow = c; }).accessor((d: Row) => d.stoSlow),
    "stoch-fast": stochasticOscillator().options({ windowSize: 14, kWindowSize: 1, dWindowSize: 3 }).merge((d: Row, c: unknown) => { d.stoFast = c; }).accessor((d: Row) => d.stoFast),
    "stoch-full": stochasticOscillator().options({ windowSize: 14, kWindowSize: 3, dWindowSize: 4 }).merge((d: Row, c: unknown) => { d.stoFull = c; }).accessor((d: Row) => d.stoFull),
    atr: atr().options({ windowSize: 14 }).merge((d: Row, c: number) => { d.atr = c; }).accessor((d: Row) => d.atr),
    "elder-ray": elderRay().merge((d: Row, c: unknown) => { d.elderRay = c; }).accessor((d: Row) => d.elderRay),
    "force-index": forceIndex().merge((d: Row, c: number) => { d.forceIndex = c; }).accessor((d: Row) => d.forceIndex),
    forceIndexEma: ema().id(7).options({ windowSize: 13, sourcePath: "forceIndex" }).merge((d: Row, c: number) => { d.fiEma13 = c; }).accessor((d: Row) => d.fiEma13),
    compare: compare().options({ basePath: "close", mainKeys: ["close"], compareKeys: ["bench"] }).merge((d: Row, c: unknown) => { d.compare = c; }).accessor((d: Row) => d.compare),
  };
}
type Calculators = ReturnType<typeof makeCalculators>;

/** Run the indicator calculators needed for `active`, in dependency order. */
function computeIndicators(rows: Row[], active: ReadonlySet<IndicatorId>, calc: Calculators, benchmark: Props["benchmark"]): Row[] {
  let data = rows;
  const run = (fn: (d: Row[]) => Row[]) => {
    data = fn(data);
  };
  for (const id of ["ema20", "ema50", "sma200", "wma20", "tma20", "bollinger", "sar", "rsi", "atr", "stoch-slow", "stoch-fast", "stoch-full"] as const) {
    if (active.has(id)) run(calc[id]);
  }
  const impulse = active.has("elder-impulse");
  if (active.has("macd") || impulse) run(calc.macd);
  if (impulse) {
    run(calc.ema13);
    markElderImpulse(data);
  }
  if (active.has("elder-ray")) run(calc["elder-ray"]);
  if (active.has("force-index")) {
    run(calc["force-index"]);
    run(calc.forceIndexEma);
  }
  if (active.has("compare") && benchmark) {
    // Carry the last known benchmark close forward over bars it has no data for.
    let last: number | undefined;
    for (const d of data) {
      last = benchmark.closes.get(d.date.getTime()) ?? last;
      d.bench = last;
    }
    run(calc.compare);
  }
  return data;
}

/**
 * Elder Impulse: green when both EMA-13 and the MACD histogram rose, red when both
 * fell, neutral otherwise. (The library's elderImpulse() factory throws on
 * construction in v2.0.1, so it's computed here.)
 */
function markElderImpulse(rows: Row[]): void {
  for (let i = 0; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    let impulse = "neutral";
    const prevDiv = prev?.macd?.divergence;
    const curDiv = cur.macd?.divergence;
    if (prev && prev.ema13 != null && cur.ema13 != null && prevDiv != null && curDiv != null) {
      if (curDiv >= prevDiv && cur.ema13 >= prev.ema13) impulse = "up";
      else if (curDiv <= prevDiv && cur.ema13 <= prev.ema13) impulse = "down";
    }
    cur.elderImpulse = impulse;
  }
}

function transformBricks(rows: Row[], chartType: ChartType): Row[] {
  let out: Row[];
  if (chartType === "renko") out = renko()(rows);
  else if (chartType === "kagi") out = kagi()(rows);
  else {
    // Point & figure: size boxes from the price range (~40 boxes top to bottom) so any
    // timeframe produces a readable number of columns. Rounded to the ₹0.05 tick.
    const hi = Math.max(...rows.map((d) => d.high));
    const lo = Math.min(...rows.map((d) => d.low));
    const boxSize = Math.max(0.05, Math.round(((hi - lo) / 40) * 20) / 20);
    out = pointAndFigure().options({ boxSize, reversal: 3, sourcePath: "high/low" })(rows);
  }
  // The calculators can emit a trailing column/brick that never got a date; the time scale can't place it.
  return out.filter((d) => d.date instanceof Date && !Number.isNaN(d.date.getTime()));
}

export default function FinancialChart(props: Props) {
  const { width, height, bars, chartType, indicators, palette, fontFamily, tool } = props;
  const bricks = BRICK_CHARTS.has(chartType);
  const calc = useMemo(() => makeCalculators(palette), [palette]);

  const scaled = useMemo(() => {
    // Copy so indicator merges never mutate the caller's bars.
    let data: Row[] = bars.map((b) => ({ ...b }));
    if (bricks) {
      data = transformBricks(data, chartType);
    } else {
      if (chartType === "heikin-ashi") data = heikinAshi()(data);
      data = computeIndicators(data, indicators, calc, props.benchmark);
    }
    const provider = discontinuousTimeScaleProviderBuilder().inputDateAccessor((d: Bar) => d.date);
    return provider(data);
  }, [bars, bricks, chartType, indicators, calc, props.benchmark]);

  const { data, xScale, xAccessor, displayXAccessor } = scaled;
  if (data.length === 0) return null;

  const panes = bricks ? [] : PANE_ORDER.filter((id) => indicators.has(id) && (id !== "compare" || props.benchmark));
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const paneHeight = panes.length ? Math.max(70, Math.min(120, Math.floor((plotHeight - 220) / panes.length))) : 0;
  const mainHeight = Math.max(160, plotHeight - paneHeight * panes.length);

  const last = xAccessor(data[data.length - 1]);
  const first = xAccessor(data[Math.max(0, data.length - 150)]);
  const xExtents = [first, last + 8];

  const font = { fontFamily, fontSize: 11 };
  const axisProps = { ...font, strokeStyle: palette.border, tickLabelFill: palette.muted, tickStrokeStyle: palette.border, gridLinesStrokeStyle: palette.grid, showGridLines: true };
  const coordProps = { ...font, fill: palette.fg, textFill: palette.bg, rectWidth: MARGIN.right };
  const tooltipProps = { ...font, labelFill: palette.muted, textFill: palette.fg };
  const isUp = (d: Row) => d.close >= d.open;
  const impulse = indicators.has("elder-impulse") && !bricks;
  const candleColor = (d: Row) => {
    if (impulse && d.elderImpulse) return d.elderImpulse === "up" ? palette.up : d.elderImpulse === "down" ? palette.down : palette.accent;
    return isUp(d) ? palette.up : palette.down;
  };
  const formatTime = (d: Date) => (props.intraday ? timeFmt : dayFmt).format(d);

  const bottomPane = panes.at(-1) ?? "main";
  const xAxis = (pane: PaneId | "main") => (
    <>
      <XAxis {...axisProps} showTickLabel={pane === bottomPane} showTicks={pane === bottomPane} />
      {pane === bottomPane && <MouseCoordinateX {...coordProps} rectWidth={undefined} displayFormat={formatTime} />}
    </>
  );

  const movingAverages = bricks ? [] : (["ema20", "ema50", "sma200", "wma20", "tma20"] as const).filter((id) => indicators.has(id));
  const tooltipRows = (movingAverages.length ? 1 : 0) + (indicators.has("bollinger") && !bricks ? 1 : 0);

  return (
    <ChartCanvas
      width={width}
      height={height}
      ratio={typeof window === "undefined" ? 1 : window.devicePixelRatio}
      margin={MARGIN}
      seriesName={`${props.seriesName}:${bricks ? chartType : "time"}`}
      data={data}
      xScale={xScale}
      xAccessor={xAccessor}
      displayXAccessor={displayXAccessor}
      xExtents={xExtents}
      zoomAnchor={lastVisibleItemBasedZoomAnchor}
      useCrossHairStyleCursor={tool === "cursor"}
    >
      {/* Price pane */}
      <Chart id={1} height={mainHeight} yExtents={(d: Row) => (chartType === "line" || chartType === "area" ? [d.close] : [d.high, d.low])} padding={{ top: 24, bottom: 16 }}>
        {xAxis("main")}
        <YAxis {...axisProps} ticks={6} tickFormat={formatPrice} />
        <MouseCoordinateY {...coordProps} displayFormat={formatPrice} />

        {indicators.has("volume-profile") && !bricks && (
          <VolumeProfileSeries
            bins={36}
            orient="right"
            maxProfileWidthPercent={30}
            fill={({ type }: { type: "up" | "down" }) => withAlpha(type === "up" ? palette.up : palette.down, 0.22)}
            stroke={withAlpha(palette.border, 0.6)}
            showSessionBackground={false}
          />
        )}

        {chartType === "candles" || chartType === "heikin-ashi" ? (
          <CandlestickSeries fill={candleColor} wickStroke={candleColor} stroke="none" />
        ) : chartType === "bars" ? (
          <OHLCSeries stroke={candleColor} strokeWidth={1.5} />
        ) : chartType === "line" ? (
          <LineSeries yAccessor={(d: Row) => d.close} strokeStyle={palette.accent} strokeWidth={2} />
        ) : chartType === "area" ? (
          <AreaSeries yAccessor={(d: Row) => d.close} strokeStyle={palette.accent} strokeWidth={2} fillStyle={withAlpha(palette.accent, 0.18)} />
        ) : chartType === "renko" ? (
          <RenkoSeries fill={{ up: palette.up, down: palette.down, partial: withAlpha(palette.muted, 0.5) }} stroke={{ up: palette.up, down: palette.down }} />
        ) : chartType === "kagi" ? (
          <KagiSeries fill={{ yang: "none", yin: "none" }} stroke={{ yang: palette.up, yin: palette.down }} strokeWidth={2} currentValueStroke={palette.muted} />
        ) : (
          <PointAndFigureSeries fill={{ up: "none", down: "none" }} stroke={{ up: palette.up, down: palette.down }} strokeWidth={1.5} />
        )}

        {movingAverages.map((id) => (
          <LineSeries key={id} yAccessor={calc[id].accessor()} strokeStyle={calc[id].stroke()} strokeWidth={1.5} />
        ))}
        {movingAverages.map((id) => (
          <CurrentCoordinate key={id} yAccessor={calc[id].accessor()} fillStyle={calc[id].stroke()} />
        ))}
        {indicators.has("bollinger") && !bricks && (
          <BollingerSeries
            yAccessor={calc.bollinger.accessor()}
            strokeStyle={{ top: palette.overlays[3], middle: withAlpha(palette.overlays[3], 0.6), bottom: palette.overlays[3] }}
            fillStyle={withAlpha(palette.overlays[3], 0.06)}
          />
        )}
        {indicators.has("sar") && !bricks && (
          <SARSeries yAccessor={calc.sar.accessor()} fillStyle={{ rising: palette.up, falling: palette.down }} strokeStyle={{ rising: palette.up, falling: palette.down }} />
        )}

        <EdgeIndicator
          {...font}
          itemType="last"
          rectWidth={MARGIN.right}
          fill={candleColor}
          lineStroke={candleColor}
          textFill="#ffffff"
          displayFormat={formatPrice}
          yAccessor={(d: Row) => d.close}
        />

        <OHLCTooltip {...tooltipProps} origin={[8, 12]} ohlcFormat={(n) => formatPrice(Number(n))} />
        {movingAverages.length > 0 && (
          <MovingAverageTooltip
            {...tooltipProps}
            origin={[8, 30]}
            displayFormat={formatPrice}
            options={movingAverages.map((id) => ({
              yAccessor: calc[id].accessor(),
              type: calc[id].type(),
              stroke: calc[id].stroke(),
              windowSize: calc[id].options().windowSize,
            }))}
          />
        )}
        {indicators.has("bollinger") && !bricks && (
          <BollingerBandTooltip {...tooltipProps} origin={[8, movingAverages.length ? 72 : 30]} yAccessor={calc.bollinger.accessor()} options={calc.bollinger.options()} displayFormat={formatPrice} />
        )}
        {indicators.has("sar") && !bricks && (
          <SingleValueTooltip {...tooltipProps} valueFill={palette.fg} origin={[8, 30 + tooltipRows * 42]} yLabel="SAR" yAccessor={calc.sar.accessor()} yDisplayFormat={formatPrice} />
        )}

        {!bricks && <DrawingLayer {...props} palette={palette} />}
        <ZoomButtons fill={palette.bg} stroke={palette.border} textFill={palette.fg} />
      </Chart>

      {/* Volume, overlaid on the bottom quarter of the price pane */}
      {indicators.has("volume") && !bricks && (
        <Chart id={2} height={mainHeight * 0.22} origin={[0, mainHeight * 0.78]} yExtents={(d: Row) => d.volume}>
          <BarSeries yAccessor={(d: Row) => d.volume} fillStyle={(d: Row) => withAlpha(isUp(d) ? palette.up : palette.down, 0.35)} />
        </Chart>
      )}

      {panes.map((pane, i) => (
        <Chart key={pane} id={10 + i} height={paneHeight} origin={[0, mainHeight + i * paneHeight]} yExtents={paneExtents(pane, calc)} padding={{ top: 14, bottom: 6 }}>
          {xAxis(pane)}
          <PaneBody pane={pane} calc={calc} palette={palette} axisProps={axisProps} coordProps={coordProps} tooltipProps={tooltipProps} benchmark={props.benchmark?.symbol} />
        </Chart>
      ))}

      <CrossHairCursor strokeStyle={palette.muted} />
    </ChartCanvas>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function paneExtents(pane: PaneId, calc: Calculators): any {
  switch (pane) {
    case "rsi":
    case "stoch-slow":
    case "stoch-fast":
    case "stoch-full":
      return [0, 100];
    case "macd":
      return calc.macd.accessor();
    case "atr":
      return (d: Row) => d.atr;
    case "elder-ray":
      return (d: Row) => (d.elderRay ? [0, d.elderRay.bullPower, d.elderRay.bearPower] : [0]);
    case "force-index":
      return (d: Row) => [0, d.fiEma13];
    case "compare":
      return (d: Row) => (d.compare ? [d.compare.close, d.compare.bench] : [0]);
  }
}

type PaneBodyProps = {
  pane: PaneId;
  calc: Calculators;
  palette: ChartPalette;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axisProps: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coordProps: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tooltipProps: any;
  benchmark?: string;
};

function PaneBody({ pane, calc, palette, axisProps, coordProps, tooltipProps, benchmark }: PaneBodyProps) {
  const [c0, , c2] = palette.overlays;
  const fixed = (digits: number) => (n: number) => n.toFixed(digits);
  const label = { ...tooltipProps, valueFill: palette.fg };

  if (pane === "rsi") {
    return (
      <>
        <YAxis {...axisProps} tickValues={[30, 50, 70]} />
        <MouseCoordinateY {...coordProps} displayFormat={fixed(1)} />
        <RSISeries
          yAccessor={calc.rsi.accessor()}
          strokeStyle={{ line: c2, top: palette.muted, middle: palette.grid, bottom: palette.muted, outsideThreshold: c0, insideThreshold: withAlpha(c2, 0.12) }}
        />
        <RSITooltip {...tooltipProps} origin={[8, 12]} yAccessor={calc.rsi.accessor()} options={calc.rsi.options()} />
      </>
    );
  }
  if (pane === "macd") {
    return (
      <>
        <YAxis {...axisProps} ticks={3} tickFormat={fixed(1)} />
        <MouseCoordinateY {...coordProps} displayFormat={fixed(2)} />
        <MACDSeries yAccessor={calc.macd.accessor()} strokeStyle={{ macd: c2, signal: c0, zero: palette.border }} fillStyle={{ divergence: withAlpha(palette.accent, 0.5) }} />
        <MACDTooltip
          {...tooltipProps}
          origin={[8, 12]}
          yAccessor={calc.macd.accessor()}
          options={calc.macd.options()}
          appearance={{ strokeStyle: { macd: c2, signal: c0 }, fillStyle: { divergence: palette.accent } }}
        />
      </>
    );
  }
  if (pane === "stoch-slow" || pane === "stoch-fast" || pane === "stoch-full") {
    const name = { "stoch-slow": "Slow STO", "stoch-fast": "Fast STO", "stoch-full": "Full STO" }[pane];
    const strokeStyle = { top: palette.muted, middle: palette.grid, bottom: palette.muted, dLine: c0, kLine: c2 };
    return (
      <>
        <YAxis {...axisProps} tickValues={[20, 50, 80]} />
        <MouseCoordinateY {...coordProps} displayFormat={fixed(1)} />
        <StochasticSeries yAccessor={calc[pane].accessor()} strokeStyle={strokeStyle} />
        <StochasticTooltip
          {...tooltipProps}
          origin={[8, 12]}
          yAccessor={calc[pane].accessor()}
          options={calc[pane].options()}
          appearance={{ stroke: { dLine: c0, kLine: c2 } }}
          label={name}
        />
      </>
    );
  }
  if (pane === "atr") {
    return (
      <>
        <YAxis {...axisProps} ticks={3} tickFormat={formatPrice} />
        <MouseCoordinateY {...coordProps} displayFormat={formatPrice} />
        <LineSeries yAccessor={calc.atr.accessor()} strokeStyle={c2} strokeWidth={1.5} />
        <SingleValueTooltip {...label} origin={[8, 12]} yLabel="ATR (14)" yAccessor={calc.atr.accessor()} yDisplayFormat={formatPrice} />
      </>
    );
  }
  if (pane === "elder-ray") {
    return (
      <>
        <YAxis {...axisProps} ticks={3} tickFormat={formatPrice} />
        <MouseCoordinateY {...coordProps} displayFormat={formatPrice} />
        <ElderRaySeries yAccessor={calc["elder-ray"].accessor()} fillStyle={{ bullPower: withAlpha(palette.up, 0.7), bearPower: withAlpha(palette.down, 0.7) }} />
        <SingleValueTooltip {...label} origin={[8, 12]} yLabel="Bull power" yAccessor={(d: Row) => d.elderRay?.bullPower} yDisplayFormat={formatPrice} />
        <SingleValueTooltip {...label} origin={[150, 12]} yLabel="Bear power" yAccessor={(d: Row) => d.elderRay?.bearPower} yDisplayFormat={formatPrice} />
      </>
    );
  }
  if (pane === "force-index") {
    return (
      <>
        <YAxis {...axisProps} ticks={3} tickFormat={formatCompact} />
        <MouseCoordinateY {...coordProps} displayFormat={formatCompact} />
        <StraightLine yValue={0} strokeStyle={palette.border} />
        <LineSeries yAccessor={calc.forceIndexEma.accessor()} strokeStyle={c2} strokeWidth={1.5} />
        <SingleValueTooltip {...label} origin={[8, 12]} yLabel="Force Index (EMA 13)" yAccessor={calc.forceIndexEma.accessor()} yDisplayFormat={formatCompact} />
      </>
    );
  }
  // compare
  return (
    <>
      <YAxis {...axisProps} ticks={3} tickFormat={formatPct} />
      <MouseCoordinateY {...coordProps} displayFormat={formatPct} />
      <StraightLine yValue={0} strokeStyle={palette.border} />
      <LineSeries yAccessor={(d: Row) => d.compare?.bench} strokeStyle={palette.muted} strokeWidth={1.5} />
      <LineSeries yAccessor={(d: Row) => d.compare?.close} strokeStyle={palette.accent} strokeWidth={2} />
      <SingleValueTooltip {...label} origin={[8, 12]} yLabel="This stock" yAccessor={(d: Row) => d.compare?.close} yDisplayFormat={formatPct} />
      <SingleValueTooltip {...label} origin={[160, 12]} yLabel={benchmark ?? "Index"} yAccessor={(d: Row) => d.compare?.bench} yDisplayFormat={formatPct} />
    </>
  );
}

/** All interactive drawing tools, on the price pane. */
function DrawingLayer({ tool, drawings, onDrawingsChange, onTextPosition, onToolDone, palette, fontFamily }: Props) {
  const done = <K extends DrawingKind>(kind: K) => (_e: unknown, items: Drawings[K]) => {
    onDrawingsChange(kind, items);
    onToolDone();
  };
  const accent = palette.accent;
  const levelStyle = useMemo(() => levelAppearance(palette, fontFamily), [palette, fontFamily]);

  return (
    <>
      <TrendLine
        enabled={tool === "trendline" || tool === "ray"}
        type={tool === "ray" ? "RAY" : "LINE"}
        snap={false}
        trends={drawings.trends}
        onStart={() => {}}
        onComplete={done("trends")}
        appearance={{ strokeStyle: accent, strokeWidth: 1.5, strokeDasharray: "Solid", edgeStrokeWidth: 1, edgeFill: palette.bg, edgeStroke: accent }}
        currentPositionStroke={accent}
      />
      <FibonacciRetracement
        enabled={tool === "fibonacci"}
        type="BOUND"
        retracements={drawings.fibs}
        onComplete={done("fibs")}
        appearance={{ strokeStyle: palette.overlays[1], strokeWidth: 1, fontFamily, fontSize: 11, fontFill: palette.fg, edgeStroke: palette.overlays[1], edgeFill: palette.bg, nsEdgeFill: palette.overlays[1], edgeStrokeWidth: 1, r: 5 }}
        currentPositionStroke={palette.overlays[1]}
      />
      <EquidistantChannel
        enabled={tool === "channel"}
        channels={drawings.channels}
        onStart={() => {}}
        onComplete={done("channels")}
        onSelect={() => {}}
        appearance={{ stroke: accent, strokeOpacity: 1, strokeWidth: 1, fill: accent, fillOpacity: 0.08, edgeStroke: accent, edgeFill: palette.bg, edgeFill2: accent, edgeStrokeWidth: 1, r: 5 }}
        currentPositionStroke={accent}
      />
      <StandardDeviationChannel
        enabled={tool === "stddev"}
        channels={drawings.stddevs}
        onComplete={done("stddevs")}
        appearance={{ stroke: palette.overlays[2], strokeOpacity: 1, strokeWidth: 1, fill: palette.overlays[2], fillOpacity: 0.1, edgeStroke: palette.overlays[2], edgeFill: palette.bg, edgeStrokeWidth: 1, r: 5 }}
        currentPositionStroke={palette.overlays[2]}
      />
      <GannFan
        enabled={tool === "gann"}
        fans={drawings.fans}
        onComplete={done("fans")}
        appearance={{
          stroke: palette.overlays[0],
          strokeOpacity: 1,
          fillOpacity: 0.1,
          strokeWidth: 1,
          edgeStroke: palette.overlays[0],
          edgeFill: palette.bg,
          edgeStrokeWidth: 1,
          r: 5,
          fill: [palette.up, palette.overlays[2], palette.overlays[1], palette.overlays[0], palette.down, palette.accent, palette.muted, palette.overlays[3]],
          fontFamily,
          fontSize: 11,
          fontFill: palette.fg,
        }}
        currentPositionStroke={palette.overlays[0]}
      />
      <InteractiveText
        enabled={tool === "text"}
        textList={drawings.texts.map((t) => ({ ...textAppearance(palette, fontFamily), ...t }))}
        defaultText={{ ...textAppearance(palette, fontFamily), text: "" }}
        onChoosePosition={(_e, newText) => {
          onTextPosition(newText.position as XY);
          onToolDone();
        }}
        onDragComplete={(_e, list) => onDrawingsChange("texts", list.map((t: TextDrawing) => ({ position: t.position, text: t.text, seq: t.seq })))}
      />
      <InteractiveYCoordinate
        enabled
        yCoordinateList={drawings.levels.map((l) => ({ ...levelStyle, ...l }))}
        onChoosePosition={() => {}}
        onDragComplete={(_e, list) => onDrawingsChange("levels", list.map((l: LevelDrawing) => ({ id: l.id, yValue: l.yValue, text: l.text, seq: l.seq })))}
        onDelete={(_e, level) => onDrawingsChange("levels", drawings.levels.filter((l) => l.id !== level.id))}
      />
      {tool === "hline" && (
        <ClickCallback
          onClick={(_e, moreProps) => {
            const yValue = moreProps.chartConfig.yScale.invert(moreProps.mouseXY[1]);
            const level: LevelDrawing = { id: `L${Date.now()}`, yValue, text: `₹${formatPrice(yValue)}` };
            onDrawingsChange("levels", [...drawings.levels, level]);
            onToolDone();
          }}
        />
      )}
    </>
  );
}

function textAppearance(palette: ChartPalette, fontFamily: string) {
  return { bgFill: palette.grid, bgOpacity: 0.9, bgStroke: palette.border, bgStrokeWidth: 1, textFill: palette.fg, fontFamily, fontWeight: "normal", fontStyle: "normal", fontSize: 12 };
}

function levelAppearance(palette: ChartPalette, fontFamily: string) {
  return {
    bgFill: palette.bg,
    bgOpacity: 1,
    stroke: palette.overlays[0],
    strokeDasharray: "ShortDash2" as const,
    strokeOpacity: 1,
    strokeWidth: 1,
    textFill: palette.overlays[0],
    fontFamily,
    fontWeight: "normal",
    fontStyle: "normal",
    fontSize: 11,
    textBox: { height: 22, left: 16, padding: { left: 8, right: 4 }, closeIcon: { padding: { left: 4, right: 8 }, width: 8 } },
    edge: {
      stroke: palette.overlays[0],
      strokeOpacity: 1,
      strokeWidth: 1,
      fill: palette.bg,
      fillOpacity: 1,
      orient: "right",
      at: "right",
      arrowWidth: 10,
      dx: 0,
      rectWidth: MARGIN.right,
      rectHeight: 20,
      displayFormat: formatPrice,
    },
  };
}
