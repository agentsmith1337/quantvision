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
  CrossHairCursor,
  CurrentCoordinate,
  EdgeIndicator,
  FibonacciRetracement,
  LineSeries,
  MACDSeries,
  MACDTooltip,
  MouseCoordinateX,
  MouseCoordinateY,
  MovingAverageTooltip,
  OHLCSeries,
  OHLCTooltip,
  RSISeries,
  RSITooltip,
  TrendLine,
  XAxis,
  YAxis,
  ZoomButtons,
  bollingerBand,
  discontinuousTimeScaleProviderBuilder,
  ema,
  heikinAshi,
  lastVisibleItemBasedZoomAnchor,
  macd,
  rsi,
  sma,
} from "react-financial-charts";
import { withAlpha, type ChartPalette } from "@/lib/chart-theme";

export type Bar = { date: Date; open: number; high: number; low: number; close: number; volume: number };
export type ChartType = "candles" | "heikin-ashi" | "bars" | "line" | "area";
export type IndicatorId = "ema20" | "ema50" | "sma200" | "bollinger" | "volume" | "rsi" | "macd";
// A bar after indicator calculators have merged their outputs onto it.
type Row = Bar & { ema20?: number; ema50?: number; sma200?: number; bb?: unknown; rsi?: number; macd?: unknown };

export type DrawingTool = "cursor" | "trendline" | "ray" | "fibonacci";

// react-financial-charts drawing objects; x values are bar indexes on the chart's scale.
export type TrendDrawing = { start: [number, number]; end: [number, number]; type: "LINE" | "RAY" | "XLINE"; selected?: boolean; appearance?: object };
export type FibDrawing = { x1: number; y1: number; x2: number; y2: number; type: "EXTEND" | "RAY" | "BOUND"; selected?: boolean; appearance?: object };

type Props = {
  width: number;
  height: number;
  seriesName: string; // changing it resets zoom/pan
  bars: Bar[];
  intraday: boolean;
  chartType: ChartType;
  indicators: ReadonlySet<IndicatorId>;
  tool: DrawingTool;
  trends: TrendDrawing[];
  fibs: FibDrawing[];
  onTrendsChange: (trends: TrendDrawing[]) => void;
  onFibsChange: (fibs: FibDrawing[]) => void;
  onToolDone: () => void;
  palette: ChartPalette;
  fontFamily: string;
};

const MARGIN = { left: 8, right: 72, top: 8, bottom: 28 };
const RSI_HEIGHT = 110;
const MACD_HEIGHT = 130;

const priceFmt = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatPrice = (n: number) => priceFmt.format(n);
const timeFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export default function FinancialChart(props: Props) {
  const { width, height, bars, chartType, indicators, palette, fontFamily, tool } = props;

  // Indicator calculators (each merges its output onto the bar objects).
  const calc = useMemo(() => {
    const [c0, c1, c2] = palette.overlays;
    return {
      ema20: ema().id(1).options({ windowSize: 20 }).merge((d: Row, c: number) => { d.ema20 = c; }).accessor((d: Row) => d.ema20).stroke(c0),
      ema50: ema().id(2).options({ windowSize: 50 }).merge((d: Row, c: number) => { d.ema50 = c; }).accessor((d: Row) => d.ema50).stroke(c1),
      sma200: sma().id(3).options({ windowSize: 200 }).merge((d: Row, c: number) => { d.sma200 = c; }).accessor((d: Row) => d.sma200).stroke(c2),
      bollinger: bollingerBand().merge((d: Row, c: unknown) => { d.bb = c; }).accessor((d: Row) => d.bb),
      rsi: rsi().options({ windowSize: 14 }).merge((d: Row, c: number) => { d.rsi = c; }).accessor((d: Row) => d.rsi),
      macd: macd().options({ fast: 12, slow: 26, signal: 9 }).merge((d: Row, c: unknown) => { d.macd = c; }).accessor((d: Row) => d.macd),
    };
  }, [palette]);

  const scaled = useMemo(() => {
    // Copy so indicator merges never mutate the caller's bars.
    let data: Row[] = bars.map((b) => ({ ...b }));
    if (chartType === "heikin-ashi") data = heikinAshi()(data);
    for (const id of ["ema20", "ema50", "sma200", "bollinger", "rsi", "macd"] as const) {
      if (indicators.has(id)) data = calc[id](data);
    }
    const provider = discontinuousTimeScaleProviderBuilder().inputDateAccessor((d: Bar) => d.date);
    return provider(data);
  }, [bars, chartType, indicators, calc]);

  const { data, xScale, xAccessor, displayXAccessor } = scaled;
  if (data.length === 0) return null;

  const showRsi = indicators.has("rsi");
  const showMacd = indicators.has("macd");
  const paneHeight = height - MARGIN.top - MARGIN.bottom;
  const mainHeight = Math.max(160, paneHeight - (showRsi ? RSI_HEIGHT : 0) - (showMacd ? MACD_HEIGHT : 0));
  const rsiOrigin = mainHeight;
  const macdOrigin = mainHeight + (showRsi ? RSI_HEIGHT : 0);

  const last = xAccessor(data[data.length - 1]);
  const first = xAccessor(data[Math.max(0, data.length - 150)]);
  const xExtents = [first, last + 8];

  const font = { fontFamily, fontSize: 11 };
  const axisProps = { ...font, strokeStyle: palette.border, tickLabelFill: palette.muted, tickStrokeStyle: palette.border, gridLinesStrokeStyle: palette.grid, showGridLines: true };
  const coordProps = { ...font, fill: palette.fg, textFill: palette.bg, rectWidth: MARGIN.right };
  const tooltipProps = { ...font, labelFill: palette.muted, textFill: palette.fg };
  const isUp = (d: Bar) => d.close >= d.open;
  const formatTime = (d: Date) => (props.intraday ? timeFmt : dayFmt).format(d);

  const movingAverages = (["ema20", "ema50", "sma200"] as const).filter((id) => indicators.has(id));
  const xAxisOn = (pane: "main" | "rsi" | "macd") => {
    const bottom = showMacd ? "macd" : showRsi ? "rsi" : "main";
    return pane === bottom;
  };
  const xAxis = (pane: "main" | "rsi" | "macd") => (
    <>
      <XAxis {...axisProps} showTickLabel={xAxisOn(pane)} showTicks={xAxisOn(pane)} />
      {xAxisOn(pane) && <MouseCoordinateX {...coordProps} rectWidth={undefined} displayFormat={formatTime} />}
    </>
  );

  return (
    <ChartCanvas
      width={width}
      height={height}
      ratio={typeof window === "undefined" ? 1 : window.devicePixelRatio}
      margin={MARGIN}
      seriesName={props.seriesName}
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

        {chartType === "candles" || chartType === "heikin-ashi" ? (
          <CandlestickSeries fill={(d: Bar) => (isUp(d) ? palette.up : palette.down)} wickStroke={(d: Bar) => (isUp(d) ? palette.up : palette.down)} stroke="none" />
        ) : chartType === "bars" ? (
          <OHLCSeries stroke={(d: Bar) => (isUp(d) ? palette.up : palette.down)} strokeWidth={1.5} />
        ) : chartType === "line" ? (
          <LineSeries yAccessor={(d: Bar) => d.close} strokeStyle={palette.accent} strokeWidth={2} />
        ) : (
          <AreaSeries yAccessor={(d: Bar) => d.close} strokeStyle={palette.accent} strokeWidth={2} fillStyle={withAlpha(palette.accent, 0.18)} />
        )}

        {movingAverages.map((id) => (
          <LineSeries key={id} yAccessor={calc[id].accessor()} strokeStyle={calc[id].stroke()} strokeWidth={1.5} />
        ))}
        {movingAverages.map((id) => (
          <CurrentCoordinate key={id} yAccessor={calc[id].accessor()} fillStyle={calc[id].stroke()} />
        ))}
        {indicators.has("bollinger") && (
          <BollingerSeries
            yAccessor={calc.bollinger.accessor()}
            strokeStyle={{ top: palette.overlays[3], middle: withAlpha(palette.overlays[3], 0.6), bottom: palette.overlays[3] }}
            fillStyle={withAlpha(palette.overlays[3], 0.06)}
          />
        )}

        <EdgeIndicator
          {...font}
          itemType="last"
          rectWidth={MARGIN.right}
          fill={(d: Bar) => (isUp(d) ? palette.up : palette.down)}
          lineStroke={(d: Bar) => (isUp(d) ? palette.up : palette.down)}
          textFill="#ffffff"
          displayFormat={formatPrice}
          yAccessor={(d: Bar) => d.close}
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
        {indicators.has("bollinger") && (
          <BollingerBandTooltip {...tooltipProps} origin={[8, movingAverages.length ? 72 : 30]} yAccessor={calc.bollinger.accessor()} options={calc.bollinger.options()} displayFormat={formatPrice} />
        )}

        <TrendLine
          enabled={tool === "trendline" || tool === "ray"}
          type={tool === "ray" ? "RAY" : "LINE"}
          snap={false}
          trends={props.trends}
          onStart={() => {}}
          onComplete={(_e, trends) => {
            props.onTrendsChange(trends);
            props.onToolDone();
          }}
          appearance={{ strokeStyle: palette.accent, strokeWidth: 1.5, strokeDasharray: "Solid", edgeStrokeWidth: 1, edgeFill: palette.bg, edgeStroke: palette.accent }}
          currentPositionStroke={palette.accent}
        />
        <FibonacciRetracement
          enabled={tool === "fibonacci"}
          type="BOUND"
          retracements={props.fibs}
          onComplete={(_e, fibs) => {
            props.onFibsChange(fibs);
            props.onToolDone();
          }}
          appearance={{ strokeStyle: palette.overlays[1], strokeWidth: 1, fontFamily, fontSize: 11, fontFill: palette.fg, edgeStroke: palette.overlays[1], edgeFill: palette.bg, nsEdgeFill: palette.overlays[1], edgeStrokeWidth: 1, r: 5 }}
          currentPositionStroke={palette.overlays[1]}
        />
        <ZoomButtons fill={palette.bg} stroke={palette.border} textFill={palette.fg} />
      </Chart>

      {/* Volume, overlaid on the bottom quarter of the price pane */}
      {indicators.has("volume") && (
        <Chart id={2} height={mainHeight * 0.22} origin={[0, mainHeight * 0.78]} yExtents={(d: Bar) => d.volume}>
          <BarSeries yAccessor={(d: Bar) => d.volume} fillStyle={(d: Bar) => withAlpha(isUp(d) ? palette.up : palette.down, 0.35)} />
        </Chart>
      )}

      {showRsi && (
        <Chart id={3} height={RSI_HEIGHT} origin={[0, rsiOrigin]} yExtents={[0, 100]} padding={{ top: 12, bottom: 8 }}>
          {xAxis("rsi")}
          <YAxis {...axisProps} tickValues={[30, 50, 70]} />
          <MouseCoordinateY {...coordProps} displayFormat={(n: number) => n.toFixed(1)} />
          <RSISeries
            yAccessor={calc.rsi.accessor()}
            strokeStyle={{ line: palette.overlays[2], top: palette.muted, middle: palette.grid, bottom: palette.muted, outsideThreshold: palette.overlays[0], insideThreshold: withAlpha(palette.overlays[2], 0.12) }}
          />
          <RSITooltip {...tooltipProps} origin={[8, 14]} yAccessor={calc.rsi.accessor()} options={calc.rsi.options()} />
        </Chart>
      )}

      {showMacd && (
        <Chart id={4} height={MACD_HEIGHT} origin={[0, macdOrigin]} yExtents={calc.macd.accessor()} padding={{ top: 12, bottom: 8 }}>
          {xAxis("macd")}
          <YAxis {...axisProps} ticks={3} tickFormat={(n: number) => n.toFixed(1)} />
          <MouseCoordinateY {...coordProps} displayFormat={(n: number) => n.toFixed(2)} />
          <MACDSeries
            yAccessor={calc.macd.accessor()}
            strokeStyle={{ macd: palette.overlays[2], signal: palette.overlays[0], zero: palette.border }}
            fillStyle={{ divergence: withAlpha(palette.accent, 0.5) }}
          />
          <MACDTooltip
            {...tooltipProps}
            origin={[8, 14]}
            yAccessor={calc.macd.accessor()}
            options={calc.macd.options()}
            appearance={{ strokeStyle: { macd: palette.overlays[2], signal: palette.overlays[0] }, fillStyle: { divergence: palette.accent } }}
          />
        </Chart>
      )}

      <CrossHairCursor strokeStyle={palette.muted} />
    </ChartCanvas>
  );
}
