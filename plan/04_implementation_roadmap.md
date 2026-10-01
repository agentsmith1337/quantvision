# Implementation Roadmap (Local Deployment)

This roadmap focuses on building a locally-hosted desktop application using Next.js and FastAPI.

## Phase 1: Core Engine & UI Foundation
*   Initialize Next.js project and configure for static export (`next build`).
*   Initialize FastAPI Python project. Configure it to serve the Next.js static files.
*   Integrate database storage (users, configurations).
*   Integrate Angel One SmartAPI and establish WebSocket connection in FastAPI.
*   **Milestone:** App runs locally via a script (`python run.py`), displays live market data on the Next.js UI using `react-financial-charts`.

## Phase 2: Local Portfolio & Manual Trading
*   Implement secure local API key storage.
*   Develop FastAPI endpoints for fetching portfolio data from Angel One.
*   Build UI for manual order execution and portfolio tracking.
*   Implement the **Order Status Polling** background task to keep the UI synced with execution status.
*   **Milestone:** Users can securely save credentials and trade manually through the local app.

## Phase 3: IDE & Local Script Execution
*   Integrate Monaco Editor into the UI (Dashboard and Backtest Studio).
*   Develop the local execution engine: FastAPI dynamically spawns a Python subprocess to run user scripts.
*   Develop the QuantVision Python SDK (a simplified wrapper around Angel One API) for users to import into their scripts.
*   Integrate **Gnews** and **Mediastack** APIs into FastAPI to fetch and serve stock-specific news.
*   Build the "Live News Feed" tab below the main trading chart in the UI.
*   **Milestone:** Users can write basic Python scripts, and view real-time news for the selected stock.

## Phase 4: Backtesting Sandbox
*   Integrate `Backtrader` into the execution engine.
*   Implement local historical data storage (Parquet files) to cache downloaded `yfinance` stock data.
*   **Milestone:** Users can run fast backtests on historical data in the dedicated Backtesting Studio.

## Phase 5: Packaging & Distribution
*   Wrap the application using PyInstaller or Tauri to create a standalone executable (`.exe`).
*   Implement auto-update mechanisms.
*   **Milestone:** A polished, one-click installer is ready for users to download and run.

## Phase 6: Future Developments (Post-Launch)
*   **AI Agentic Coder:** Integrate an LLM (OpenAI/Gemini) to assist with code generation in the IDE.
*   **AI News Analyst:** Build a news ingestion pipeline and use an LLM for real-time sentiment analysis.
