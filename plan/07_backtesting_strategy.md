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
*   **Secondary/Intraday Source:** Angel One `getCandleData()`.
    *   Used specifically when the user requests highly granular (1-minute) historical data that `yfinance` cannot provide.
*   **Premium Option (Future):** Allow users to input API keys for dedicated data vendors like TrueData or Polygon.io if they need massive datasets of historical tick data.

## 3. Local Data Caching Strategy
To ensure backtests run in seconds rather than minutes, we must cache data locally. **We will not use SQLite for this.**

*   **Technology:** Parquet files (`.parquet`) via Pandas.
*   **Why:** Parquet is a columnar storage format optimized for time-series data. It is exponentially faster to read/write large arrays of price data than a relational database like SQLite.
*   **Flow:**
    1. User requests a backtest for `TCS` from `2020` to `2024`.
    2. FastAPI checks the local `/data_cache/` directory for `TCS_1D_2020_2024.parquet`.
    3. If found, it loads the data into Pandas in milliseconds.
    4. If not found, it downloads the data via `yfinance`, saves the `.parquet` file locally for future use, and then proceeds.

## 4. Execution Workflow

1.  **Script Submission:** The user clicks "Run Sandbox" in the Next.js IDE. The Python script string and backtest parameters (dates, starting capital, symbol) are sent to FastAPI.
2.  **Data Loading:** FastAPI loads the required historical data into a Pandas DataFrame using the caching strategy above.
3.  **Sandbox Execution:** FastAPI dynamically loads the user's Python code and injects it into the `Backtrader` engine alongside the Pandas DataFrame.
4.  **Simulation:** The engine runs the simulation, factoring in a configurable commission rate (to simulate real Angel One charges) and slippage.
5.  **Result Generation:** FastAPI extracts the final metrics (Total Return, Win Rate, Drawdown curve, list of executed trades).
6.  **UI Rendering:** The Next.js frontend receives the JSON results and renders a beautiful equity curve chart and a table of the simulated trades.
