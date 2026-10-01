# Product Specifications: QuantVision Algorithmic Trading Engine

## 1. Overview
QuantVision is an algorithmic trading engine and web application connected to the Angel One API. It empowers users to monitor real-time markets, manage their portfolios, develop algorithmic trading strategies via an integrated IDE, backtest these strategies in a sandbox, and deploy them for real-time execution.

## 2. Core Features

### 2.1. Real-Time Market Data & Charting
*   **Live Data Feed:** Stream real-time stock prices and market depth from Angel One via WebSockets.
*   **Advanced Charting:** Integration with `react-financial-charts` for interactive charts, built-in technical indicators, and drawing tools (trendlines, Fibonacci).
*   **Watchlists:** Manage custom watchlists.

### 2.2. Portfolio Management
*   **Real-Time Dashboard:** View current holdings, open positions, realized and unrealized P&L.
*   **Order Management:** Track status of active, executed, and cancelled orders.

### 2.3. Integrated Development Environment (IDE) & Scripting
*   **In-App Code Editor:** A Monaco-based code editor supporting Python.
*   **Technical Indicators:** Pre-built functions (SMA, EMA, RSI, MACD) for user scripts.
*   **Angel One SDK Integration:** Simplified SDK for users to fetch data and trade within scripts.

### 2.4. Backtesting Sandbox
*   **Historical Data:** Fetch historical candle data for simulations.
*   **Simulation Engine:** Execute scripts against historical data safely.
*   **Performance Metrics:** Max Drawdown, Sharpe Ratio, Win Rate, etc.

### 2.5. Real-Time Execution Engine
*   **Strategy Deployment:** Deploy backtested scripts to live markets.
*   **Kill Switch:** Global emergency stop for all automated trading.

## 3. Future Developments (Placeholders)
*   **Agentic Coder (Copilot):** AI assistant that helps users write, debug, and optimize trading scripts based on natural language.
*   **News-Based Analyst:** AI agent that ingests financial news and provides sentiment analysis as an actionable trading signal.

## 4. User Personas
*   **The Quantitative Analyst:** Wants a robust API, reliable backtesting, and fast execution for their complex statistical models.
*   **The AI Enthusiast Trader:** Relies heavily on the AI agents to write code and gauge market sentiment, combining AI insights with basic technical rules.
*   **The Retail Algo Trader:** Wants a visual, easy-to-use platform that handles the infrastructure so they can focus on strategy logic.
