# Backtesting Strategy & Data Management

A robust backtesting engine is critical for an algorithmic trading platform. Since this app runs locally, we can leverage the user's local file system for high-performance data caching.

## 1. The Backtesting Engine
We will utilize an existing, industry-standard Python library rather than building an engine from scratch.

*   **Primary Recommendation:** `Backtrader`. 
    *   *Why:* It is an event-driven engine, meaning the code the user writes for the backtest closely mirrors the code they will use for live trading (handling data bar-by-bar). It automatically calculates essential metrics (Sharpe Ratio, Max Drawdown) and handles simulated broker logic (commissions, slippage).
*   **Alternative:** `vectorbt`. Extremely fast because it uses Pandas vectorization, but the coding style is less intuitive for event-driven live trading.

## 2. Historical Data Sources
Relying solely on Angel One for years of historical data is often slow and subject to API rate limits. We need a faster alternative.

*   **Primary Source:** `yfinance` (Yahoo Finance API).
    *   *Pros:* Completely free, very fast, requires no API key, and provides excellent daily and hourly data for Indian stocks (using the `.NS` suffix, e.g., `RELIANCE.NS`).
    *   *Cons:* Limited intra-day (1-minute) data history (usually only the last 30 days).
*   **Decision (Phase 4): `yfinance` only.** No broker login is needed to backtest. Yahoo's windows are enforced up front with a clear message: daily candles go back decades, 1h covers the last 730 days, 15m/5m the last 60, and 1m the last 30 (fetched 7 days per request). Prices are split-adjusted, not dividend-adjusted (`auto_adjust=False`).
*   **Possible later addition:** Angel One `getCandleData()` for multi-year intraday history (needs broker login, 1 request/second).
*   **Premium Option (Future):** Allow users to input API keys for dedicated data vendors like TrueData or Polygon.io if they need massive datasets of historical tick data.

## 3. Local Data Caching Strategy
To ensure backtests run in seconds rather than minutes, we must cache data locally. **We will not use SQLite for this.**

*   **Technology:** Parquet files (`.parquet`) via Pandas.
*   **Why:** Parquet is a columnar storage format optimized for time-series data. It is exponentially faster to read/write large arrays of price data than a relational database like SQLite.
*   **Layout (implemented):** one file per Yahoo ticker and interval, e.g. `QV_HOME/data_cache/TCS.NS_1d.parquet`, plus `TCS.NS_1d.json` listing the date ranges already downloaded. (Per-range files like `TCS_1D_2020_2024.parquet` would duplicate overlapping data.)
*   **Flow:**
    1. User requests a backtest for `TCS` from `2020` to `2024` (plus ~300 warm-up candles before 2020).
    2. FastAPI compares the request with the downloaded ranges.
    3. Only the missing date ranges are downloaded via `yfinance` and merged into the file; the rest loads from Parquet in milliseconds.
    4. Today's candles are never marked as downloaded (the session may not be over), so they're refreshed next time.

## 4. Execution Workflow (as implemented)

1.  **Submission:** "Run simulation" in the Studio sends the script name, universe (up to 20 stocks; indices can be watched but not traded), interval, dates, capital, slippage and charge overrides to `POST /api/backtests`. One backtest runs at a time.
2.  **Data Loading:** FastAPI loads/caches the candles (above) and the NIFTY 50 benchmark, and writes each stock's slice to a temporary Parquet file.
3.  **Sandbox Execution:** `python -m quantvision.backtest` runs in the isolated script environment (no credentials, own process). It loads the *unchanged* `on_candle` script and drives it from a generated `Backtrader` strategy, reusing the SDK's `api` and `indicators` objects. Indicators see a moving window ending at the current candle (no look-ahead).
4.  **Simulation:** orders fill on a later candle (market: next open; limit/stop: when reached), with slippage. QuantVision's own rules sit on top of Backtrader's matching: DELIVERY needs cash/holdings, INTRADAY 20% margin with shorting and a 15:15 auto square-off, DAY validity, and Angel One's per-product charges (brokerage, STT, exchange, SEBI, stamp duty, GST, DP) on every fill.
5.  **Result Generation:** return, CAGR, Sharpe/Sortino, max drawdown and duration, win rate, profit factor, charges, exposure, benchmark return, equity/drawdown curve, round-trip trades, executions, per-stock stats and logs. Saved as `QV_HOME/backtests/<id>.json` with the exact script (last 50 kept).
6.  **UI Rendering:** the Studio's results pane shows the metrics, an equity curve against NIFTY 50 with drawdown, and tables of trades and executions; earlier backtests can be reopened.
