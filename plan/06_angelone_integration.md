# Angel One API Integration Strategy

This document outlines how the FastAPI backend will communicate with the Angel One SmartAPI to fetch data and execute trades.

## 1. The Official SDK
Instead of making raw HTTP requests, the Python backend will utilize the official Angel One Python library:
`pip install smartapi-python`

## 2. Authentication Flow (The Local Challenge)
Angel One requires a Multi-Factor Authentication (MFA) flow, specifically using a TOTP (Time-based One-Time Password) along with the API Key and Client Code.

**Flow:**
1.  **Setup Page (Next.js UI):** User enters API Key, Client Code, Password, and their TOTP Secret (from their authenticator app setup).
2.  **Storage:** FastAPI encrypts and stores these in the local SQLite database.
3.  **Session Generation:** When the backend starts, it uses the `pyotp` library to generate the current TOTP token using the stored secret.
4.  **Login:** FastAPI calls `SmartConnect(api_key).generateSession(client_code, password, generated_totp)`.
5.  **Token Management:** The returned `feed_token` and `jwt_token` are held in FastAPI memory for the duration of the session to authorize subsequent requests.

## 3. Real-Time Market Data (WebSockets)
We will use the Angel One `SmartWebSocketV2` to stream tick data.

**Architecture:**
1.  FastAPI establishes a single WebSocket connection to Angel One using the `feed_token`.
2.  FastAPI subscribes to the tokens (symbols) present in the user's active watchlists and the currently viewed Trading Dashboard chart.
3.  As ticks (LTP updates, volume) arrive from Angel One, FastAPI parses them and immediately broadcasts them over a *local* WebSocket connection to the Next.js frontend.

## 4. Order Status Polling (Execution Tracking)
Unlike price data, Angel One does not stream order execution status (e.g., an order moving from "Pending" to "Executed" or "Rejected") over WebSockets.

**Strategy:**
1.  FastAPI implements a background task that polls the `orderBook()` and `tradeBook()` endpoints every 3 seconds during active market hours.
2.  When a state change is detected, FastAPI updates the local SQLite trade log and pushes a notification over the local WebSocket to the Next.js frontend to instantly update the UI (triggering the Live Execution Sidecard).

## 5. Required Angel One SDK Methods to Wrap

Our FastAPI backend will expose its own local REST endpoints (e.g., `POST /api/orders/buy`) for the Next.js UI to call. Internally, those FastAPI endpoints will execute the following official Angel One `smartapi-python` methods:

*   **Market Data:**
    *   `getCandleData(historicParam)`: Fetches historical OHLCV data.
    *   `getLTPData(exchange, tradingsymbol, symboltoken)`: Fetches the absolute latest price.
*   **Portfolio Management:**
    *   `position()`: Retrieves open positions.
    *   `holding()`: Retrieves long-term portfolio holdings.
    *   `rmsLimit()`: Retrieves available margin and cash balances.
*   **Order Execution:**
    *   `placeOrder(orderparams)`: Submits Buy/Sell orders.
    *   `modifyOrder(orderparams)`: Updates a pending order.
    *   `cancelOrder(variety, orderid)`: Cancels a pending order.
    *   `orderBook()`: Retrieves the status of all orders placed today.

## 6. Instrument Search (Daily Scrip Master)
Symbol search does **not** call SmartAPI's `searchScrip()` (rate-limited to roughly 1 request per second). Instead the backend uses Angel One's public daily instrument file:

`https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json` (~34 MB, ~145k instruments)

1.  **Download once a day** in the background (at startup, and on the first search after 08:00 IST when the cached copy is from an earlier day). No credentials are needed.
2.  **Filter and cache** to NSE `-EQ` equities, BSE cash equities and NSE/BSE indices (~16k rows, ~0.8 MB) in `QV_HOME/scripmaster.json`. If a download fails, the previous day's copy keeps serving searches.
3.  **Company names:** the scrip master only has tickers, so NSE's list of listed equities (`https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv`) is downloaded alongside it. BSE listings take the name of the NSE company with the same symbol; BSE-only companies remain ticker-only.
4.  **Search in memory** on every keystroke, by symbol or company name: exact match, then prefix, then any word of the name ("bank" finds State Bank of India), then substring; indices first, NSE before BSE.
5.  **Resolve tokens on demand:** any symbol opened from search, a URL or the watchlist is looked up in the file and registered (with its token) in SQLite on first use.
6.  `searchScrip()` remains only as a fallback when no copy of the file has ever been downloaded.

## 7. Algorithmic Script Wrapper & Wrapping Engine
To provide a simple, TradingView-like coding experience while retaining the power of `Backtrader`, users write **one plain function**, `on_candle`, and QuantVision runs it everywhere: paper trading, live trading and (Phase 4) backtests.

### 7.1 Engines
1.  **Technical Indicators (`pandas-ta-classic`):** Angel One does not provide technical indicators. The SDK bundles `pandas-ta-classic` (the maintained, MIT-licensed fork of `pandas-ta`, same API, 190+ indicators; the original `pandas-ta` does not install on Python 3.14).
2.  **Live / paper runs:** QuantVision's own runner. The engine builds candles from the live tick stream and calls the user's `on_candle` as each candle closes. Orders go through the same broker, risk limits and kill switch as manual trading, and follow the **global Paper/Live switch** (if the switch is changed while a script runs, its next orders use the new mode).
3.  **Backtests (Phase 4):** FastAPI generates a `Backtrader` strategy class that wraps the *same* `on_candle` function, so a script runs unchanged in a backtest.

### 7.2 The script contract
A script is a `.py` file in `Documents/QuantVision/scripts/`. A strategy is **not limited to one stock**: each run has a *universe* of up to 20 symbols and one candle interval.

```python
# Optional defaults for the Run dialog (editable there).
SYMBOLS = ["RELIANCE", "TCS", "INFY"]
INTERVAL = "5m"            # 1m, 5m, 15m, 1h or 1d

def on_candle(candle, indicators, api):
    # Called once for every closed candle of every symbol in the universe.
    # candle.symbol says which stock this candle belongs to.
    sma_20 = indicators.sma(period=20)          # this candle's stock
    nifty_rsi = indicators.rsi(period=14, symbol="NIFTY")  # any stock in the universe

    if candle.close > sma_20 and api.position() == 0:
        api.buy(quantity=10)                    # buys candle.symbol
    if api.position("TCS") > 0 and nifty_rsi > 70:
        api.sell(quantity=api.position("TCS"), symbol="TCS")
```

*   **Required:** `on_candle(candle, indicators, api)`.
*   **Optional hooks:** `on_start(api)` (once, before the first candle), `on_order(order, api)` (an order of this run filled, was rejected or cancelled), `on_stop(api)` (once, when the run ends).
*   **Optional constants:** `SYMBOLS`, `INTERVAL` pre-fill the Run dialog.
*   **Default symbol:** inside `on_candle`, every `indicators.*` and `api.*` call that takes `symbol=` defaults to `candle.symbol`. Other stocks must be in the run's universe.
*   **Candle order:** when several stocks' candles close at the same time, `on_candle` is called for each in universe order. A stock's candle closes at the end of its interval (even if no trade happened in the last seconds); intraday intervals are aligned to the 09:15 IST market open.

**`candle`**: `symbol`, `time` (IST `datetime` of the candle start), `open`, `high`, `low`, `close`, `volume`.

**`indicators`**: values for the **latest closed candle**, calculated with `pandas-ta-classic` on that stock's history (the run starts with ~300 historical candles per stock):
*   `sma(period, symbol=None)`, `ema`, `wma`, `rsi`, `atr`, `vwap(symbol=None)` → a number (or `None` while not enough history).
*   `macd(fast=12, slow=26, signal=9)` → `.macd`, `.signal`, `.histogram`; `bbands(period=20, std=2)` → `.upper`, `.middle`, `.lower`; `stoch(k=14, d=3, smooth_k=3)` → `.k`, `.d`; `supertrend(period=7, multiplier=3)` → `.value`, `.direction` (1 up, -1 down); `adx(period=14)` → `.adx`, `.plus_di`, `.minus_di`.
*   `df(symbol=None)` → the full OHLCV `pandas.DataFrame`, for any other `pandas-ta-classic` indicator (`indicators.df().ta.cci(length=20)`).

**`api`**: the only way a script reaches the broker. The script never sees credentials.
*   `buy(quantity, symbol=None, order_type="MARKET", price=None, trigger_price=None, product="DELIVERY")`, `sell(...)` → the order (`.order_id`, `.status`, `.average_price`, …). `product="INTRADAY"` for margin/shorting.
*   `position(symbol=None)` → net quantity held (holdings + today's positions; negative when short).
*   `orders()`, `cancel(order_id)`, `cancel_all()`, `funds()` (`.available_cash`), `ltp(symbol=None)`, `history(symbol=None, n=100)` (DataFrame), `log(*values)` (also `print()`), `mode` (`"paper"` or `"live"`).

### 7.3 Safety rules (enforced by the engine, not the SDK)
*   Every script order passes the same checks as manual orders: max order value, max orders per minute, static-IP check for live.
*   Each run is additionally limited to **10 orders per minute**; exceeding it rejects the order with an error the script can see.
*   The **Kill switch** stops every running script and cancels all open orders.
*   Scripts run in a separate Python process and virtual environment (`QV_HOME/runtime`), with no broker credentials in their environment. An exception inside `on_candle` is logged and the run continues; 5 consecutive failures stop the run.
