# QuantVision Strategy SDK

Write a trading strategy as one Python function, `on_candle`. QuantVision calls it every time a candle closes, for every stock your strategy watches. The same script runs in **paper** and **live** trading today, and in the Backtesting Studio (Phase 4).

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

Values for the **latest closed candle**, calculated with [pandas-ta-classic](https://github.com/xgboosted/pandas-ta-classic). Every function returns `None` until there's enough history.

| Call | Returns |
|---|---|
| `sma(period=20, symbol=None)` | simple moving average |
| `ema(period=20, symbol=None)` | exponential moving average |
| `wma(period=20, symbol=None)` | weighted moving average |
| `rsi(period=14, symbol=None)` | relative strength index, 0–100 |
| `atr(period=14, symbol=None)` | average true range, in rupees |
| `vwap(symbol=None)` | volume-weighted average price, reset daily |
| `macd(fast=12, slow=26, signal=9, symbol=None)` | `.macd`, `.signal`, `.histogram` |
| `bbands(period=20, std=2.0, symbol=None)` | `.upper`, `.middle`, `.lower` |
| `stoch(k=14, d=3, smooth_k=3, symbol=None)` | `.k`, `.d` |
| `supertrend(period=7, multiplier=3.0, symbol=None)` | `.value`, `.direction` (1 up, -1 down) |
| `adx(period=14, symbol=None)` | `.adx`, `.plus_di`, `.minus_di` |
| `df(symbol=None)` | the stock's OHLCV history as a `pandas.DataFrame` |

### Any other indicator

`indicators.df()` gives you the full history, with pandas-ta-classic's `.ta` accessor and its 190+ indicators:

```python
def on_candle(candle, indicators, api):
    df = indicators.df()
    cci = df.ta.cci(length=20).iloc[-1]          # Commodity Channel Index
    ichimoku, _ = df.ta.ichimoku()
    api.log("CCI", round(cci, 1))
```

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
| `api.mode` | `"paper"` or `"live"` |

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
