# QuantVision Strategy SDK

Write a trading strategy as one Python function, `on_candle`. QuantVision calls it every time a candle closes, for every stock your strategy watches. The same script runs in **paper** and **live** trading and in **backtests** in the Backtesting Studio.

## Quick start

```python
SYMBOLS = ["RELIANCE", "TCS", "INFY"]   # stocks to watch (editable when you press Run)
INTERVAL = "5m"                         # candle size: 1m, 5m, 15m, 1h or 1d

def on_candle(candle, indicators, api):
    rsi = indicators.rsi(period=14)     # RSI of the stock this candle belongs to
    if rsi is None:
        return                          # not enough history yet

    if rsi < 30 and api.position() == 0:
        api.buy(quantity=1)             # buys candle.symbol
    elif rsi > 70 and api.position() > 0:
        api.sell(quantity=api.position())
```

1. Save the script (it lives in `Documents/QuantVision/scripts/`, so you can also edit it in VS Code).
2. Press **Run**, check the stocks and candle interval, and start.
3. Watch the run's log. **Stop** ends it; the **Kill switch** stops every script and cancels all open orders.

> Orders follow the app's **Paper / Live** switch (top bar). In **LIVE** mode a script trades real money. Never run code you don't understand, especially scripts copied from the internet.

## How a run works

* A run watches a **universe** of 1–20 stocks on **one** candle interval.
* At start, each stock gets about **300 historical candles**, so indicators work immediately.
* `on_candle` is called once per **closed** candle per stock. When several stocks' candles close together, it's called for each, in universe order. `candle.symbol` tells you which stock.
* Intraday candles are aligned to the 09:15 IST market open (hourly candles are 09:15, 10:15, …). A candle closes at the end of its interval even if the last seconds had no trades.
* Outside market hours no candles close, so `on_candle` isn't called.
* Inside `on_candle`, every `indicators` and `api` call that takes `symbol=` defaults to **`candle.symbol`**. You can use any other stock in the universe by naming it: `indicators.rsi(period=14, symbol="NIFTY")`.

## Hooks

| Function | Required | Called |
|---|---|---|
| `on_candle(candle, indicators, api)` | yes | every closed candle of every stock in the universe |
| `on_start(api)` | no | once, before the first candle |
| `on_order(order, api)` | no | when an order placed by this run fills, is rejected or cancelled |
| `on_stop(api)` | no | once, when the run is stopped |

Outside `on_candle`, the default `symbol` is the first stock in the universe (in `on_order`, the order's stock).

Optional module-level constants pre-fill the Run dialog: `SYMBOLS` (list of symbols) and `INTERVAL`.

## `candle`

| Field | Meaning |
|---|---|
| `symbol` | the stock, e.g. `"RELIANCE"`; BSE listings look like `"BSE:RELIANCE"` |
| `time` | candle start, a timezone-aware `datetime` in IST |
| `open`, `high`, `low`, `close` | prices in rupees |
| `volume` | shares traded during the candle |

## `indicators`

Every indicator in [pandas-ta-classic](https://github.com/xgboosted/pandas-ta-classic), plus TA-Lib's candlestick patterns, is a named shortcut. The **Indicator reference** at the end of this page lists all of them with every parameter and default.

```python
indicators.rsi(period=14)                 # 41.7: the latest closed candle's value
indicators.macd().histogram               # multi-value indicators have named fields
indicators.bbands(period=20, std=2).upper
indicators.supertrend(symbol="NIFTY").direction   # 1 up, -1 down; any stock in the run
indicators.cdl_engulfing()                # 100 bullish, -100 bearish, 0 none
indicators.beta(other="NIFTY", period=30) # two-stock statistics take other=
```

Rules that hold for every shortcut:

* The value is for the **latest closed candle**. It's `None` while there isn't enough history (multi-value indicators return their fields as `None`).
* `symbol=` (keyword only) picks the stock; it defaults to `candle.symbol` and must be in the run's universe.
* pandas-ta's `length` is called `period` (`length=` is accepted too). Every other parameter keeps its pandas-ta name.
* Numbers are plain `float`s; candlestick patterns are `int`s; a few labels (e.g. `cpr().position`) are text.
* Indicators are calculated with pandas-ta's own Python code (not TA-Lib), so values match the library's documentation. TA-Lib is used only for the candlestick patterns.

### Helpers

| Call | Returns |
|---|---|
| `series(name, **params, symbol=None)` | the indicator's whole history: a `pandas.Series`, or a `DataFrame` whose columns are the field names |
| `crossed_above(a, b)` | `True` if `a` crossed above `b` on the latest candle. `a`/`b` are Series (from `series()` or `df()`) or a number |
| `crossed_below(a, b)` | `True` if `a` crossed below `b` on the latest candle |
| `available()` | `{name: description}` for every shortcut |
| `df(symbol=None)` | the stock's OHLCV history as a `pandas.DataFrame` (IST index), with pandas-ta-classic's `.ta` accessor |

```python
def on_candle(candle, indicators, api):
    fast = indicators.series("ema", period=9)
    slow = indicators.series("ema", period=21)
    if indicators.crossed_above(fast, slow) and api.position() == 0:
        api.buy(quantity=1)
    elif indicators.crossed_below(indicators.series("rsi"), 70) and api.position() > 0:
        api.sell(quantity=api.position())                             # RSI falling back below 70
```

`series()` fields are columns: `indicators.series("macd")["histogram"]`.

## `api`

The only way a script reaches your broker account. Scripts never see your credentials.

### Orders

```python
api.buy(quantity, symbol=None, order_type="MARKET", price=None, trigger_price=None, product="DELIVERY")
api.sell(quantity, symbol=None, order_type="MARKET", price=None, trigger_price=None, product="DELIVERY")
```

* `order_type`: `"MARKET"`, `"LIMIT"` (needs `price`), `"SL"` (needs `price` and `trigger_price`), `"SL-M"` (needs `trigger_price`).
* `product`: `"DELIVERY"` (cash; you can only sell what you hold) or `"INTRADAY"` (margin; allows short selling; positions must be closed the same day).
* Returns the **order**: `.order_id`, `.symbol`, `.side`, `.status` (`"complete"`, `"open"`, `"trigger pending"`, `"rejected"`, `"cancelled"`), `.average_price`, `.filled_quantity`, `.message`, and `.rejected` / `.is_open` shortcuts.
* A rejected order (risk limit, insufficient funds, …) doesn't raise an exception: check `order.rejected` and `order.message`. The rejection is also written to the log.

| Call | Does |
|---|---|
| `api.position(symbol=None)` | net quantity held: holdings plus today's positions (negative when short) |
| `api.orders()` | today's orders placed by this run |
| `api.cancel(order_id)` | cancel one of this run's open orders |
| `api.cancel_all()` | cancel all of this run's open orders; returns how many |
| `api.funds()` | `.available_cash`, `.used_margin`, `.net` |
| `api.ltp(symbol=None)` | last traded price right now |
| `api.history(symbol=None, n=100)` | the last `n` closed candles as a DataFrame |
| `api.log(*values)` | write to the run's log (`print()` works too) |
| `api.mode` | `"paper"`, `"live"`, or `"backtest"` in the Backtesting Studio |

## Backtesting

The **Run simulation** button in the Backtesting Studio runs the same script, unchanged, on historical candles. Choose the stocks (the script's `SYMBOLS` by default), the candle size, the dates, your starting capital and the costs.

**Data.** Candles come from Yahoo Finance and are cached in `Documents/QuantVision/data_cache`, so a repeat backtest starts instantly. Daily candles go back decades; Yahoo keeps 1h candles for 730 days, 15m and 5m for 60 days, and 1m for 30 days. Prices are split-adjusted, not dividend-adjusted. About 300 candles before the start date are loaded first, so indicators have values from the first simulated candle.

**What differs from a live run**

* `on_candle` runs once per closed candle per stock, in universe order, and sees only candles up to that one. Nothing from the future is visible.
* `on_start` runs just before the first simulated candle; `on_stop` after the last.
* Orders never fill on the candle that placed them. A **MARKET** order fills at the **next candle's open** (plus slippage). **LIMIT**, **SL** and **SL-M** orders fill when a later candle reaches their price (at the open if it gaps through).
* `api.buy()` / `api.sell()` therefore return the order as `"open"` or `"trigger pending"`; `on_order` is called when it fills, is cancelled or rejected. `api.position()` changes once the fill happens.
* Orders are **DAY** orders: anything unfilled at the end of the trading day it could first fill in is cancelled.
* **DELIVERY** buys need the cash (including charges); sells need holdings. **INTRADAY** needs 20% margin, allows short selling, is only available on 1h and shorter candles, and is **squared off automatically at 15:15** (after that, no new INTRADAY orders that day).
* `api.ltp()` is the latest candle's close; `api.funds()` reflects the simulated account.
* **Costs:** Angel One's charges (brokerage, STT, exchange and SEBI fees, stamp duty, GST, DP charge on delivery sells) are deducted from every fill. Defaults follow Angel One's published tariff and can be changed under **Costs**, together with slippage.
* The 10-orders-a-minute limit and the static-IP check apply only to live runs. Indices can be watched (e.g. as a filter) but not traded.

**Results:** net P&L and return, return of NIFTY 50 bought with the same capital, CAGR, Sharpe and Sortino (annualised from daily returns, risk-free rate 0%), maximum drawdown, win rate and profit factor of round-trip trades (after charges), the equity curve, every trade and execution, per-stock results and the log. Each backtest is saved with the exact script it ran.

## Safety rules

These are enforced by the QuantVision engine, outside your script, so a bug can't bypass them:

* Every order passes the same checks as manual orders: **max value per order**, **max orders per minute** (Settings → Preferences) and, in live mode, the **static IP** check.
* Each run is limited to **10 orders per minute**; extra orders are rejected.
* An exception inside a hook is logged with its traceback and the run continues. **5 consecutive errors stop the run.**
* The **Kill switch** stops every running script and cancels every open order.
* Scripts run in their own Python process and environment (`Documents/QuantVision/runtime`). They can read and write files like any program you run, so only run code you trust.

## Examples

### Moving-average crossover on several stocks

```python
SYMBOLS = ["SBIN", "HDFCBANK", "ICICIBANK"]
INTERVAL = "15m"

def on_candle(candle, indicators, api):
    fast = indicators.ema(period=20)
    slow = indicators.ema(period=50)
    if fast is None or slow is None:
        return
    held = api.position()
    if fast > slow and held == 0:
        api.buy(quantity=1)
    elif fast < slow and held > 0:
        api.sell(quantity=held)
```

### Trade only when the market agrees

```python
SYMBOLS = ["NIFTY", "RELIANCE", "TCS"]
INTERVAL = "5m"

def on_candle(candle, indicators, api):
    if candle.symbol == "NIFTY":
        return                                   # NIFTY is only used as a filter
    market_up = indicators.supertrend(symbol="NIFTY").direction == 1
    if market_up and indicators.rsi() < 35 and api.position() == 0:
        api.buy(quantity=1, product="INTRADAY")
```

### Bracket-style exit with a stop-loss order

```python
def on_order(order, api):
    if order.side == "BUY" and order.status == "complete":
        stop = round(order.average_price * 0.98, 1)        # 2% below entry
        api.sell(quantity=order.filled_quantity, symbol=order.symbol,
                 order_type="SL-M", trigger_price=stop)
```

<!-- indicators:start -->
## Indicator reference

246 shortcuts: 184 indicators and 62 candlestick patterns, all called as `indicators.<name>(...)`. Each returns the latest closed candle's value (`None` without enough history), takes `symbol=`, and has a full-history twin `indicators.series("<name>", ...)`. Generated from `indicator_catalog.json`, which the editor's autocomplete also uses.

### Candlestick patterns (64)

Candlestick patterns return 100 (bullish), -100 (bearish) or 0 (no pattern) for the latest candle; most take no parameters.

| Shortcut | Returns | What it is |
|---|---|---|
| `cdl_2crows(symbol=None)` | 100 bullish, -100 bearish, 0 none | Two Crows candlestick pattern. |
| `cdl_3blackcrows(symbol=None)` | 100 bullish, -100 bearish, 0 none | Three Black Crows candlestick pattern. |
| `cdl_3inside(symbol=None)` | 100 bullish, -100 bearish, 0 none | Three Inside Up/Down candlestick pattern. |
| `cdl_3linestrike(symbol=None)` | 100 bullish, -100 bearish, 0 none | Three-Line Strike candlestick pattern. |
| `cdl_3outside(symbol=None)` | 100 bullish, -100 bearish, 0 none | Three Outside Up/Down candlestick pattern. |
| `cdl_3starsinsouth(symbol=None)` | 100 bullish, -100 bearish, 0 none | Three Stars In The South candlestick pattern. |
| `cdl_3whitesoldiers(symbol=None)` | 100 bullish, -100 bearish, 0 none | Three Advancing White Soldiers candlestick pattern. |
| `cdl_abandonedbaby(penetration=0.3, symbol=None)` | 100 bullish, -100 bearish, 0 none | Abandoned Baby candlestick pattern. |
| `cdl_advanceblock(symbol=None)` | 100 bullish, -100 bearish, 0 none | Advance Block candlestick pattern. |
| `cdl_belthold(symbol=None)` | 100 bullish, -100 bearish, 0 none | Belt-hold candlestick pattern. |
| `cdl_breakaway(symbol=None)` | 100 bullish, -100 bearish, 0 none | Breakaway candlestick pattern. |
| `cdl_closingmarubozu(symbol=None)` | 100 bullish, -100 bearish, 0 none | Closing Marubozu candlestick pattern. |
| `cdl_concealbabyswall(symbol=None)` | 100 bullish, -100 bearish, 0 none | Concealing Baby Swallow candlestick pattern. |
| `cdl_counterattack(symbol=None)` | 100 bullish, -100 bearish, 0 none | Counterattack candlestick pattern. |
| `cdl_darkcloudcover(penetration=0.5, symbol=None)` | 100 bullish, -100 bearish, 0 none | Dark Cloud Cover candlestick pattern. |
| `cdl_doji(period=10, factor=10, scalar=100, asint=True, symbol=None)` | number | Candle Type: Doji. |
| `cdl_dojistar(symbol=None)` | 100 bullish, -100 bearish, 0 none | Doji Star candlestick pattern. |
| `cdl_dragonflydoji(symbol=None)` | 100 bullish, -100 bearish, 0 none | Dragonfly Doji candlestick pattern. |
| `cdl_engulfing(symbol=None)` | 100 bullish, -100 bearish, 0 none | Engulfing Pattern candlestick pattern. |
| `cdl_eveningdojistar(penetration=0.3, symbol=None)` | 100 bullish, -100 bearish, 0 none | Evening Doji Star candlestick pattern. |
| `cdl_eveningstar(penetration=0.3, symbol=None)` | 100 bullish, -100 bearish, 0 none | Evening Star candlestick pattern. |
| `cdl_gapsidesidewhite(symbol=None)` | 100 bullish, -100 bearish, 0 none | Up/Down-gap side-by-side white lines candlestick pattern. |
| `cdl_gravestonedoji(symbol=None)` | 100 bullish, -100 bearish, 0 none | Gravestone Doji candlestick pattern. |
| `cdl_hammer(symbol=None)` | 100 bullish, -100 bearish, 0 none | Hammer candlestick pattern. |
| `cdl_hangingman(symbol=None)` | 100 bullish, -100 bearish, 0 none | Hanging Man candlestick pattern. |
| `cdl_harami(symbol=None)` | 100 bullish, -100 bearish, 0 none | Harami Pattern candlestick pattern. |
| `cdl_haramicross(symbol=None)` | 100 bullish, -100 bearish, 0 none | Harami Cross Pattern candlestick pattern. |
| `cdl_highwave(symbol=None)` | 100 bullish, -100 bearish, 0 none | High-Wave Candle candlestick pattern. |
| `cdl_hikkake(symbol=None)` | 100 bullish, -100 bearish, 0 none | Hikkake Pattern candlestick pattern. |
| `cdl_hikkakemod(symbol=None)` | 100 bullish, -100 bearish, 0 none | Modified Hikkake Pattern candlestick pattern. |
| `cdl_homingpigeon(symbol=None)` | 100 bullish, -100 bearish, 0 none | Homing Pigeon candlestick pattern. |
| `cdl_identical3crows(symbol=None)` | 100 bullish, -100 bearish, 0 none | Identical Three Crows candlestick pattern. |
| `cdl_inneck(symbol=None)` | 100 bullish, -100 bearish, 0 none | In-Neck Pattern candlestick pattern. |
| `cdl_inside(asbool=False, symbol=None)` | number | Candle Type: Inside Bar. |
| `cdl_invertedhammer(symbol=None)` | 100 bullish, -100 bearish, 0 none | Inverted Hammer candlestick pattern. |
| `cdl_kicking(symbol=None)` | 100 bullish, -100 bearish, 0 none | Kicking candlestick pattern. |
| `cdl_kickingbylength(symbol=None)` | 100 bullish, -100 bearish, 0 none | Kicking - bull/bear determined by the longer marubozu candlestick pattern. |
| `cdl_ladderbottom(symbol=None)` | 100 bullish, -100 bearish, 0 none | Ladder Bottom candlestick pattern. |
| `cdl_longleggeddoji(symbol=None)` | 100 bullish, -100 bearish, 0 none | Long Legged Doji candlestick pattern. |
| `cdl_longline(symbol=None)` | 100 bullish, -100 bearish, 0 none | Long Line Candle candlestick pattern. |
| `cdl_marubozu(symbol=None)` | 100 bullish, -100 bearish, 0 none | Marubozu candlestick pattern. |
| `cdl_matchinglow(symbol=None)` | 100 bullish, -100 bearish, 0 none | Matching Low candlestick pattern. |
| `cdl_mathold(penetration=0.5, symbol=None)` | 100 bullish, -100 bearish, 0 none | Mat Hold candlestick pattern. |
| `cdl_morningdojistar(penetration=0.3, symbol=None)` | 100 bullish, -100 bearish, 0 none | Morning Doji Star candlestick pattern. |
| `cdl_morningstar(penetration=0.3, symbol=None)` | 100 bullish, -100 bearish, 0 none | Morning Star candlestick pattern. |
| `cdl_onneck(symbol=None)` | 100 bullish, -100 bearish, 0 none | On-Neck Pattern candlestick pattern. |
| `cdl_piercing(symbol=None)` | 100 bullish, -100 bearish, 0 none | Piercing Pattern candlestick pattern. |
| `cdl_rickshawman(symbol=None)` | 100 bullish, -100 bearish, 0 none | Rickshaw Man candlestick pattern. |
| `cdl_risefall3methods(symbol=None)` | 100 bullish, -100 bearish, 0 none | Rising/Falling Three Methods candlestick pattern. |
| `cdl_separatinglines(symbol=None)` | 100 bullish, -100 bearish, 0 none | Separating Lines candlestick pattern. |
| `cdl_shootingstar(symbol=None)` | 100 bullish, -100 bearish, 0 none | Shooting Star candlestick pattern. |
| `cdl_shortline(symbol=None)` | 100 bullish, -100 bearish, 0 none | Short Line Candle candlestick pattern. |
| `cdl_spinningtop(symbol=None)` | 100 bullish, -100 bearish, 0 none | Spinning Top candlestick pattern. |
| `cdl_stalledpattern(symbol=None)` | 100 bullish, -100 bearish, 0 none | Stalled Pattern candlestick pattern. |
| `cdl_sticksandwich(symbol=None)` | 100 bullish, -100 bearish, 0 none | Stick Sandwich candlestick pattern. |
| `cdl_takuri(symbol=None)` | 100 bullish, -100 bearish, 0 none | Takuri (Dragonfly Doji with very long lower shadow) candlestick pattern. |
| `cdl_tasukigap(symbol=None)` | 100 bullish, -100 bearish, 0 none | Tasuki Gap candlestick pattern. |
| `cdl_thrusting(symbol=None)` | 100 bullish, -100 bearish, 0 none | Thrusting Pattern candlestick pattern. |
| `cdl_tristar(symbol=None)` | 100 bullish, -100 bearish, 0 none | Tristar Pattern candlestick pattern. |
| `cdl_unique3river(symbol=None)` | 100 bullish, -100 bearish, 0 none | Unique 3 River candlestick pattern. |
| `cdl_upsidegap2crows(symbol=None)` | 100 bullish, -100 bearish, 0 none | Upside Gap Two Crows candlestick pattern. |
| `cdl_xsidegap3methods(symbol=None)` | 100 bullish, -100 bearish, 0 none | Upside/Downside Gap Three Methods candlestick pattern. |
| `cdl_z(period=30, full=False, ddof=1, symbol=None)` | `.open`, `.high`, `.low`, `.close` | Candle Type: Z. |
| `ha(symbol=None)` | `.open`, `.high`, `.low`, `.close` | Heikin Ashi Candles (HA). |

### Cycles (8)

| Shortcut | Returns | What it is |
|---|---|---|
| `dsp(period=14, symbol=None)` | number | Detrended Synthetic Price (DSP). |
| `ebsw(period=40, bars=10, symbol=None)` | number | Even Better SineWave (EBSW) *beta*. |
| `ht_dcperiod(symbol=None)` | number | Hilbert Transform - Dominant Cycle Period (HT_DCPERIOD). |
| `ht_dcphase(symbol=None)` | number | Hilbert Transform - Dominant Cycle Phase (HT_DCPHASE). |
| `ht_phasor(symbol=None)` | `.inphase`, `.quadrature` | Hilbert Transform - Phasor Components (HT_PHASOR). |
| `ht_sine(symbol=None)` | `.sine`, `.lead_sine` | Hilbert Transform - SineWave (HT_SINE). |
| `ht_trendmode(symbol=None)` | number | Hilbert Transform - Trend vs Cycle Mode (HT_TRENDMODE). |
| `msw(period=5, symbol=None)` | `.sine`, `.lead` | Mesa Sine Wave (MSW). |

### Momentum (53)

| Shortcut | Returns | What it is |
|---|---|---|
| `ao(fast=5, slow=34, symbol=None)` | number | Awesome Oscillator (AO). |
| `apo(fast=12, slow=26, mamode='sma', symbol=None)` | number | Absolute Price Oscillator (APO). |
| `bias(period=26, mamode='sma', symbol=None)` | number | Bias (BIAS). |
| `bop(scalar=1, symbol=None)` | number | Balance of Power (BOP). |
| `brar(period=26, scalar=100, drift=1, symbol=None)` | `.ar`, `.br` | BRAR (BRAR). |
| `cci(period=14, c=0.015, symbol=None)` | number | Commodity Channel Index (CCI). |
| `cfo(period=9, scalar=100, drift=1, symbol=None)` | number | Chande Forcast Oscillator (CFO). |
| `cg(period=10, symbol=None)` | number | Center of Gravity (CG). |
| `cmo(period=14, scalar=100, drift=1, symbol=None)` | number | Chande Momentum Oscillator (CMO). |
| `coppock(period=10, fast=11, slow=14, symbol=None)` | number | Coppock Curve (COPC). |
| `cti(period=12, symbol=None)` | number | Correlation Trend Indicator (CTI). |
| `dm(period=14, mamode='rma', drift=1, symbol=None)` | `.plus_dm`, `.minus_dm` | Directional Movement (DM). |
| `er(period=10, drift=1, symbol=None)` | number | Efficiency Ratio (ER). |
| `eri(period=13, symbol=None)` | `.bull_power`, `.bear_power` | Elder Ray Index (ERI). |
| `fisher(period=9, signal=1, symbol=None)` | `.fisher`, `.signal` | Fisher Transform (FISHT). |
| `fosc(period=14, symbol=None)` | number | Forecast Oscillator (FOSC). |
| `inertia(period=20, rvi_length=14, scalar=100, refined=False, thirds=False, mamode='ema', drift=1, symbol=None)` | number | Inertia (INERTIA). |
| `kdj(period=9, signal=3, symbol=None)` | `.k`, `.d`, `.j` | KDJ (KDJ). |
| `kst(roc1=10, roc2=15, roc3=20, roc4=30, sma1=10, sma2=10, sma3=10, sma4=15, signal=9, drift=1, symbol=None)` | `.kst`, `.signal` | 'Know Sure Thing' (KST). |
| `lrsi(period=14, gamma=0.5, symbol=None)` | number | Laguerre RSI (LRSI). |
| `macd(fast=12, slow=26, signal=9, symbol=None)` | `.macd`, `.signal`, `.histogram` | Moving Average Convergence Divergence (MACD). |
| `macdext(fast=12, slow=26, signal=9, fastmatype=1, slowmatype=1, signalmatype=1, symbol=None)` | `.macd`, `.signal`, `.histogram` | MACD Extended (MACDEXT). |
| `macdfix(signal=9, symbol=None)` | `.macd`, `.histogram`, `.signal` | MACD with Fixed Periods (MACDFIX). |
| `mom(period=10, symbol=None)` | number | Momentum (MOM). |
| `pgo(period=14, symbol=None)` | number | Pretty Good Oscillator (PGO). |
| `po(period=14, symbol=None)` | number | Projection Oscillator (PO). |
| `ppo(fast=12, slow=26, signal=9, scalar=100, mamode='sma', symbol=None)` | `.ppo`, `.histogram`, `.signal` | Percentage Price Oscillator (PPO). |
| `psl(period=12, scalar=100, drift=1, symbol=None)` | number | Psychological Line (PSL). |
| `pvo(fast=12, slow=26, signal=9, scalar=100, symbol=None)` | `.pvo`, `.histogram`, `.signal` | Percentage Volume Oscillator (PVO). |
| `qqe(period=14, smooth=5, factor=4.236, mamode='ema', drift=1, symbol=None)` | `.qqe`, `.rsi_ma`, `.long`, `.short`, `.long_band`, `.short_band`, `.direction` | Quantitative Qualitative Estimation (QQE). |
| `roc(period=10, scalar=100, symbol=None)` | number | Rate of Change (ROC). |
| `rocp(period=10, symbol=None)` | number | Rate of Change Percentage (ROCP). |
| `rocr(period=10, symbol=None)` | number | Rate of Change Ratio (ROCR). |
| `rocr100(period=10, symbol=None)` | number | Rate of Change Ratio * 100 (ROCR100). |
| `rsi(period=14, scalar=100, drift=1, symbol=None)` | number | Relative Strength Index (RSI). |
| `rsx(period=14, drift=1, symbol=None)` | number | Relative Strength Xtra (rsx). |
| `rvgi(period=14, swma_length=4, symbol=None)` | `.histogram`, `.rvgi`, `.signal` | Relative Vigor Index (RVGI). |
| `slope(period=1, as_angle=False, to_degrees=False, vertical=False, symbol=None)` | number | Slope. |
| `smc_sweep(period=15, wick_mult=1.5, symbol=None)` | number | Smart Money Concept Liquidity Sweep (SMC_SWEEP). |
| `smi(fast=5, slow=20, signal=5, scalar=1, symbol=None)` | `.smi`, `.signal`, `.oscillator` | SMI Ergodic Indicator (SMI). |
| `squeeze(bb_length=20, bb_std=2.0, kc_length=20, kc_scalar=1.5, mom_length=12, mom_smooth=6, use_tr=True, mamode='sma', symbol=None)` | `.sqz`, `.on`, `.off`, `.no_squeeze` | Squeeze (SQZ). |
| `squeeze_pro(bb_length=20, bb_std=2.0, kc_length=20, kc_scalar_wide=2, kc_scalar_normal=1.5, kc_scalar_narrow=1, mom_length=12, mom_smooth=6, use_tr=True, mamode='sma', symbol=None)` | `.sqz`, `.on_wide`, `.on_normal`, `.on_narrow`, `.off`, `.no_squeeze` | Squeeze PRO(SQZPRO). |
| `stc(tclength=10, fast=12, slow=26, factor=0.5, symbol=None)` | `.stc`, `.macd`, `.stoch` | Schaff Trend Cycle (STC). |
| `stoch(k=14, d=3, smooth_k=3, mamode='sma', symbol=None)` | `.k`, `.d` | Stochastic (STOCH). |
| `stochf(fastk=5, fastd=3, mamode='sma', symbol=None)` | `.k`, `.d` | Stochastic Fast (STOCHF). |
| `stochrsi(period=14, rsi_length=14, k=3, d=3, mamode='sma', symbol=None)` | `.k`, `.d` | Stochastic (STOCHRSI). |
| `td_seq(asint=False, symbol=None)` | `.up`, `.down` | TD Sequential (TD_SEQ). |
| `trix(period=30, signal=9, scalar=100, drift=1, symbol=None)` | `.trix`, `.signal` | Trix (TRIX). |
| `trixh(period=18, signal=9, scalar=100, drift=1, symbol=None)` | `.trix`, `.signal`, `.histogram` | TRIX Histogram (TRIXH). |
| `tsi(fast=13, slow=25, signal=13, scalar=100, mamode='ema', drift=1, symbol=None)` | `.tsi`, `.signal` | True Strength Index (TSI). |
| `uo(fast=7, medium=14, slow=28, fast_w=4.0, medium_w=2.0, slow_w=1.0, drift=1, symbol=None)` | number | Ultimate Oscillator (UO). |
| `vwmacd(fast=12, slow=26, signal=9, symbol=None)` | `.macd`, `.histogram`, `.signal` | Volume Weighted MACD (VWMACD). |
| `willr(period=14, symbol=None)` | number | William's Percent R (WILLR). |

### Moving averages & overlays (44)

| Shortcut | Returns | What it is |
|---|---|---|
| `alma(period=10, sigma=6.0, distribution_offset=0.85, symbol=None)` | number | Arnaud Legoux Moving Average (ALMA). |
| `avgprice(symbol=None)` | number | Average Price (AVGPRICE). |
| `dema(period=10, symbol=None)` | number | Double Exponential Moving Average (DEMA). |
| `ema(period=20, symbol=None)` | number | Exponential Moving Average (EMA). |
| `fwma(period=10, asc=True, symbol=None)` | number | Fibonacci's Weighted Moving Average (FWMA). |
| `hilo(high_length=13, low_length=21, mamode='sma', symbol=None)` | `.hilo`, `.long`, `.short` | Gann HiLo Activator(HiLo). |
| `hl2(symbol=None)` | number | HL2 (Median Price). |
| `hlc3(symbol=None)` | number | HLC3 (Typical Price). |
| `hma(period=10, symbol=None)` | number | Hull Moving Average (HMA). |
| `ht_trendline(symbol=None)` | number | Hilbert Transform - Instantaneous Trendline (HT_TRENDLINE). |
| `hwma(na=0.2, nb=0.1, nc=0.1, symbol=None)` | number | HWMA (Holt-Winter Moving Average). |
| `ichimoku(tenkan=9, kijun=26, senkou=52, include_chikou=True, symbol=None)` | `.span_a`, `.span_b`, `.tenkan`, `.kijun`, `.chikou` | Ichimoku Kinkō Hyō (ichimoku). *chikou is the close shifted 26 candles back, so its latest value is always None in live trading; the forward cloud isn't returned.* |
| `jma(period=7, phase=0, symbol=None)` | number | Jurik Moving Average Average (JMA). |
| `kama(period=10, fast=2, slow=30, drift=1, symbol=None)` | number | Kaufman's Adaptive Moving Average (KAMA). |
| `linreg(period=14, symbol=None)` | number | Linear Regression Moving Average (linreg). |
| `linregangle(period=14, symbol=None)` | number | Linear Regression Angle (LINEARREG_ANGLE). |
| `linregintercept(period=14, symbol=None)` | number | Linear Regression Intercept (LINEARREG_INTERCEPT). |
| `linregslope(period=14, symbol=None)` | number | Linear Regression Slope (LINEARREG_SLOPE). |
| `mama(fastlimit=0.5, slowlimit=0.05, symbol=None)` | `.mama`, `.fama` | MESA Adaptive Moving Average (MAMA). |
| `mcgd(period=10, c=1, symbol=None)` | number | McGinley Dynamic Indicator. |
| `medprice(symbol=None)` | number | Median Price (MEDPRICE). |
| `midpoint(period=2, symbol=None)` | number | Midpoint Over Period (MIDPOINT). |
| `midprice(period=2, symbol=None)` | number | Midpoint Price Over Period (MIDPRICE). |
| `mmar(period=10, symbol=None)` | `.ma1`, `.ma2`, `.ma3`, `.ma4`, `.ma5`, `.ma6` | Madrid Moving Average Ribbon (MMAR). |
| `ohlc4(symbol=None)` | number | OHLC4 (Average of Open, High, Low, Close). |
| `pwma(period=10, asc=True, symbol=None)` | number | Pascal's Weighted Moving Average (PWMA). |
| `rainbow(period=2, symbol=None)` | `.ma1`, `.ma2`, `.ma3`, `.ma4`, `.ma5`, `.ma6`, `.ma7`, `.ma8`, `.ma9`, `.ma10` | Rainbow Charts. |
| `rma(period=10, symbol=None)` | number | Wilder's Moving Average (RMA). |
| `sinwma(period=14, symbol=None)` | number | Sine Weighted Moving Average (SWMA). |
| `sma(period=20, symbol=None)` | number | Simple Moving Average (SMA). |
| `ssf(period=10, poles=2, symbol=None)` | number | Ehler's Super Smoother Filter (SSF) © 2013. |
| `supertrend(period=7, multiplier=3.0, symbol=None)` | `.value`, `.direction`, `.long`, `.short` | Supertrend (supertrend). |
| `swma(period=10, asc=True, symbol=None)` | number | Symmetric Weighted Moving Average (SWMA). |
| `t3(period=10, a=0.7, symbol=None)` | number | Tim Tillson's T3 Moving Average (T3). |
| `tema(period=10, symbol=None)` | number | Triple Exponential Moving Average (TEMA). |
| `trima(period=10, symbol=None)` | number | Triangular Moving Average (TRIMA). |
| `tsf(period=14, symbol=None)` | number | Time Series Forecast (TSF). |
| `typprice(symbol=None)` | number | Typical Price (TYPPRICE). |
| `vidya(period=14, drift=1, symbol=None)` | number | Variable Index Dynamic Average (VIDYA). |
| `vwap(anchor='D', symbol=None)` | number | Volume Weighted Average Price (VWAP). *Resets each trading day (anchor='D').* |
| `vwma(period=10, symbol=None)` | number | Volume Weighted Moving Average (VWMA). |
| `wcp(symbol=None)` | number | Weighted Closing Price (WCP). |
| `wma(period=20, asc=True, symbol=None)` | number | Weighted Moving Average (WMA). |
| `zlma(period=10, mamode='ema', symbol=None)` | number | Zero Lag Moving Average (ZLMA). |

### Performance (3)

| Shortcut | Returns | What it is |
|---|---|---|
| `drawdown(symbol=None)` | `.drawdown`, `.percent`, `.log` | Drawdown (DD). |
| `log_return(period=1, cumulative=False, symbol=None)` | number | Log Return. |
| `percent_return(period=1, cumulative=False, symbol=None)` | number | Percent Return. |

### Statistics (14)

| Shortcut | Returns | What it is |
|---|---|---|
| `beta(other=None, period=30, symbol=None)` | number | Beta (BETA). Compares this stock with `other`. |
| `correl(other=None, period=30, symbol=None)` | number | Pearson Correlation Coefficient (CORREL). Compares this stock with `other`. |
| `entropy(period=10, base=2.0, symbol=None)` | number | Entropy (ENTP). |
| `kurtosis(period=30, symbol=None)` | number | Rolling Kurtosis. |
| `mad(period=30, symbol=None)` | number | Rolling Mean Absolute Deviation. |
| `md(period=30, symbol=None)` | number | Mean Deviation (MD). |
| `median(period=30, symbol=None)` | number | Rolling Median. |
| `quantile(period=30, q=0.5, symbol=None)` | number | Rolling Quantile. |
| `skew(period=30, symbol=None)` | number | Rolling Skew. |
| `stderr(period=14, ddof=1, symbol=None)` | number | Standard Error (STDERR). |
| `stdev(period=30, ddof=0, symbol=None)` | number | Rolling Standard Deviation. |
| `tos_stdevall(period=30, stds=[1, 2, 3], ddof=1, symbol=None)` | `.lr`, `.lower_1`, `.upper_1`, `.lower_2`, `.upper_2`, `.lower_3`, `.upper_3` | TD Ameritrade's Think or Swim Standard Deviation All (TOS_STDEV). *Regression over all available history.* |
| `variance(period=30, ddof=0, symbol=None)` | number | Rolling Variance. |
| `zscore(period=30, std=1, symbol=None)` | number | Rolling Z Score. |

### Trend (22)

| Shortcut | Returns | What it is |
|---|---|---|
| `adx(period=14, lensig=None, scalar=100, mamode='rma', drift=1, symbol=None)` | `.adx`, `.plus_di`, `.minus_di` | Average Directional Movement (ADX). `lensig` defaults to `period`. |
| `adxr(period=14, lensig=None, scalar=100, mamode='rma', drift=1, symbol=None)` | `.adxr`, `.plus_di`, `.minus_di` | Average Directional Movement Index Rating (ADXR). `lensig` defaults to `period`. |
| `amat(fast=8, slow=21, lookback=2, mamode='ema', symbol=None)` | `.long_run`, `.short_run` | Archer Moving Averages Trends (AMAT). |
| `aroon(period=14, scalar=100, symbol=None)` | `.down`, `.up`, `.oscillator` | Aroon & Aroon Oscillator (AROON). |
| `chop(period=14, atr_length=1, ln=False, scalar=100, drift=1, symbol=None)` | number | Choppiness Index (CHOP). |
| `cksp(p=10, x=3, q=20, tvmode=True, symbol=None)` | `.long_stop`, `.short_stop` | Chande Kroll Stop (CKSP). |
| `cpr(method='classic', timeframe='daily', interval=None, levels='standard', width_analysis=True, price_position=True, virgin_cpr=False, symbol=None)` | `.tc`, `.pivot`, `.bc`, `.r1`, `.r2`, `.s1`, `.s2`, `.width`, `.width_pct`, `.width_class`, `.position` | CPR (Central Pivot Range). *width_class and position are text labels.* |
| `decay(kind=None, period=5, mode='linear', symbol=None)` | number | Decay. |
| `decreasing(period=1, strict=False, asint=True, percent=False, drift=1, symbol=None)` | number | Decreasing. |
| `dpo(period=20, symbol=None)` | number | Detrend Price Oscillator (DPO). *Computed non-centred (no look-ahead).* |
| `dx(period=14, scalar=100, mamode='rma', drift=1, symbol=None)` | number | Directional Index (DX). |
| `edecay(period=5, symbol=None)` | number | Exponential Decay (EDECAY). |
| `increasing(period=1, strict=False, asint=True, percent=False, drift=1, symbol=None)` | number | Increasing. |
| `minus_dm(period=14, drift=1, symbol=None)` | number | Minus Directional Movement (-DM, MINUS_DM). |
| `plus_dm(period=14, drift=1, symbol=None)` | number | Plus Directional Movement (+DM, PLUS_DM). |
| `pmax(period=10, multiplier=3.0, mamode='ema', symbol=None)` | number | PMAX (Price Max). |
| `psar(af0=None, af=0.02, max_af=0.2, symbol=None)` | `.long`, `.short`, `.af`, `.reversal` | Parabolic Stop and Reverse (psar). `af0` defaults to `af`. |
| `qstick(period=10, symbol=None)` | number | Q Stick. |
| `sarext(startvalue=0.0, offsetonreverse=0.0, accelerationinitlong=0.02, accelerationlong=0.02, accelerationmaxlong=0.2, accelerationinitshort=0.02, accelerationshort=0.02, accelerationmaxshort=0.2, symbol=None)` | number | Parabolic SAR Extended (SAREXT). |
| `ttm_trend(period=6, symbol=None)` | number | TTM Trend (TTM_TRND). |
| `vhf(period=28, drift=1, symbol=None)` | number | Vertical Horizontal Filter (VHF). |
| `vortex(period=14, drift=1, symbol=None)` | `.plus`, `.minus` | Vortex. |

### Volatility (18)

| Shortcut | Returns | What it is |
|---|---|---|
| `aberration(period=5, atr_length=15, symbol=None)` | `.middle`, `.upper`, `.lower`, `.atr` | Aberration. |
| `accbands(period=20, c=4, drift=1, mamode='sma', symbol=None)` | `.lower`, `.middle`, `.upper` | Acceleration Bands (ACCBANDS). |
| `atr(period=14, mamode='rma', drift=1, symbol=None)` | number | Average True Range (ATR). |
| `avolume(period=20, symbol=None)` | number | Annualised Historical Volatility (VOLATILITY). |
| `bbands(period=20, std=2.0, ddof=0, mamode='sma', symbol=None)` | `.upper`, `.middle`, `.lower`, `.bandwidth`, `.percent` | Bollinger Bands (BBANDS). |
| `ce(period=22, multiplier=3.0, mamode='rma', symbol=None)` | `.long_stop`, `.short_stop` | Chandelier Exit (CE). |
| `cvi(period=10, symbol=None)` | number | Chaikins Volatility (CVI). |
| `donchian(lower_length=20, upper_length=20, symbol=None)` | `.lower`, `.middle`, `.upper` | Donchian Channels (DC). |
| `hvol(period=20, annualization=252, symbol=None)` | number | Historical Volatility (HVOL). |
| `hwc(na=0.2, nb=0.1, nc=0.1, nd=0.1, scalar=1, channel_eval=False, symbol=None)` | `.middle`, `.upper`, `.lower` | HWC (Holt-Winter Channel). |
| `kc(period=20, scalar=2, mamode='ema', symbol=None)` | `.lower`, `.basis`, `.upper` | Keltner Channels (KC). |
| `massi(fast=9, slow=25, symbol=None)` | number | Mass Index (MASSI). |
| `natr(period=14, scalar=100, mamode='rma', drift=1, symbol=None)` | number | Normalized Average True Range (NATR). |
| `pdist(drift=1, symbol=None)` | number | Price Distance (PDIST). |
| `rvi(period=14, scalar=100, refined=False, thirds=False, mamode='ema', drift=1, symbol=None)` | number | Relative Volatility Index (RVI). |
| `thermo(period=20, long=2, short=0.5, mamode='ema', drift=1, symbol=None)` | `.thermo`, `.ma`, `.long`, `.short` | Elders Thermometer (THERMO). |
| `true_range(drift=1, symbol=None)` | number | True Range. |
| `ui(period=14, scalar=100, symbol=None)` | number | Ulcer Index (UI). |

### Volume (20)

| Shortcut | Returns | What it is |
|---|---|---|
| `ad(symbol=None)` | number | Accumulation/Distribution (AD). |
| `adosc(fast=3, slow=10, symbol=None)` | number | Accumulation/Distribution Oscillator or Chaikin Oscillator. |
| `aobv(fast=4, slow=12, max_lookback=2, min_lookback=2, mamode='ema', symbol=None)` | `.obv`, `.obv_min`, `.obv_max`, `.obv_fast`, `.obv_slow`, `.long_run`, `.short_run` | Archer On Balance Volume (AOBV). |
| `cmf(period=20, symbol=None)` | number | Chaikin Money Flow (CMF). |
| `efi(period=13, mamode='ema', drift=1, symbol=None)` | number | Elder's Force Index (EFI). |
| `emv(drift=1, symbol=None)` | number | Ease of Movement (EMV). |
| `eom(period=14, divisor=100000000, drift=1, symbol=None)` | number | Ease of Movement (EOM). |
| `kvo(fast=34, slow=55, signal=13, mamode='ema', drift=1, symbol=None)` | `.kvo`, `.signal` | Klinger Volume Oscillator (KVO). |
| `marketfi(symbol=None)` | number | Market Facilitation Index (MARKETFI). |
| `mfi(period=14, drift=1, symbol=None)` | number | Money Flow Index (MFI). |
| `nvi(period=1, initial=1000, symbol=None)` | number | Negative Volume Index (NVI). |
| `obv(symbol=None)` | number | On Balance Volume (OBV). |
| `pvi(period=1, initial=1000, symbol=None)` | number | Positive Volume Index (PVI). |
| `pvol(symbol=None)` | number | Price-Volume (PVOL). |
| `pvr(symbol=None)` | number | Price Volume Rank. |
| `pvt(drift=1, symbol=None)` | number | Price-Volume Trend (PVT). |
| `vfi(period=130, coef=0.2, vcoef=2.5, mamode='ema', symbol=None)` | number | Volume Flow Indicator (VFI). |
| `vosc(fast=14, slow=28, symbol=None)` | number | Volume Oscillator (VOSC). |
| `vp(width=10, symbol=None)` | DataFrame | Volume Profile (VP). *Returns a table (pandas.DataFrame) of price ranges for the whole history, not a per-candle value.* |
| `wad(symbol=None)` | number | Williams Accumulation/Distribution (WAD). |

<!-- indicators:end -->
