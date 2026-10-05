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
*   Integrate the **Gnews** API into FastAPI to fetch and serve stock-specific news. **(Note: The backend must query the API using an OR logic combining the full company name and the base symbol, e.g., `"RELIANCE INDUSTRIES" OR "RELIANCE"`, ensuring maximum article coverage).**
*   Build the "Live News Feed" tab below the main trading chart in the UI.
*   **Milestone:** Users can write basic Python scripts, and view real-time news for the selected stock.

## Phase 4: Backtesting Sandbox
*   Integrate `Backtrader` into the execution engine.
*   Implement local historical data storage (Parquet files) to cache downloaded `yfinance` stock data.
*   **Milestone:** Users can run fast backtests on historical data in the dedicated Backtesting Studio.

## Phase 5: AI Agents (Copilot & News Analyst)
*   **AI Agentic Coder:** Integrate an LLM to assist with code generation in the IDE, using Context Stuffing (`sdk_reference.md`).
*   **AI News Analyst:** Build a news ingestion pipeline (Gnews/RSS) and use an LLM for real-time sentiment analysis.
*   **Expanded Context SDK:** Expose market internals (`api.get_index()`, `api.get_sentiment()`) to the scripting engine so the LLM can write multi-variable strategies.
*   **Milestone:** Users can generate strategies via chat and see live sentiment gauges.

## Phase 6: Machine Learning Studio
*   Build a Jupyter-like notebook UI directly into the Next.js frontend (handling `.ipynb` files).
*   Implement **native execution**: Code cells run directly in the local FastAPI backend's Python environment (no Docker required).
*   Build an integrated Terminal mirroring Jupyter's terminal capabilities.
*   Implement a **Remote Compute Connection**: Allow users to seamlessly attach the UI to a remote server (e.g., Google Colab, Runpod) for GPU-accelerated model training while keeping the workflow inside QuantVision.
*   Implement **ML Inference Hooks**: Build an internal bridge allowing algorithmic trading scripts to easily attach to and call trained models for live/backtest inference, regardless of whether the model is running natively or hosted on a remote server.
*   **Milestone:** Users can train ML models and deploy them seamlessly into live trading strategies for real-time inference.
