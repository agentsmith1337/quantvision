# Frontend Architecture & UI Layout (Next.js)

## 1. Global Application Shell (Layout)
The application will utilize a persistent global layout wrapper (`layout.tsx` in Next.js) for all authenticated routes to ensure a consistent experience.

*   **Left Sidebar (Expandable):**
    *   **Header:** QuantVision Logo (utilizing the provided `assets/icon.svg`).
    *   **Navigation:** Icons and labels for Home, Portfolio, Trading Dashboard, and Backtesting Studio.
    *   **Behavior:** Can be collapsed to show only icons, maximizing screen real estate for charts and IDE.
*   **Top Navigation Bar:**
    *   **Right Side:** A consistent User Profile Picture. Clicking it reveals an "Account Options" dropdown card containing links to Settings, API Configuration, a **Theme Toggle** (Day Mode, Evening Mode, Dark Mode), and Sign Out.

## 2. Page Hierarchy & Routing

### 2.1. Home Page (`/`)
*   **Purpose:** The main landing area.
*   **Content:** An overview of QuantVision, its features (Algo IDE, AI Analysis, Local Execution), system health status, and quick-start guides.

### 2.2. Authentication & Onboarding
*   **Sign In Page (`/signin`):**
    *   Inputs: Local User ID and Password.
    *   Action: A prominent "Sign Up / Initial Setup" button that redirects to the Setup Page.
*   **Setup Page (`/setup`):**
    *   **Purpose:** Initial configuration of the local application.
    *   **Fields:** Set Local User ID, Password, and select/upload a Profile Picture.
    *   **API Configuration:** Input fields for the Angel One API Key, Secret Key, and Client Code.
    *   **Preferences:** Toggles for enabling various features.

### 2.3. Portfolio Page (`/portfolio`)
*   **Top Row (Indices):** Global market index cards (Nifty 50, Sensex, BankNifty) showing real-time price and daily percentage change.
*   **Search Bar:** A prominent global search input to find stocks.
*   **Main Content Grid:**
    *   **Current Holdings:** A data table displaying invested stocks, average buy price, Last Traded Price (LTP), and real-time P&L.
    *   **Watchlists:** Customizable lists of tracked stocks.
*   **Live Execution Sidecard:** A sliding or popping side panel that automatically appears when the background algorithmic engine executes a live trade.

### 2.4. Trading Dashboard Page (`/trade/[symbol]`)
This is the core operational screen for monitoring live markets, manual trading, and rapid script editing.

*   **Left Column (Market Data & Analysis):**
    *   **Top Area (Price Graph):** Integrated `react-financial-charts` for candlestick rendering, drawing tools (trendlines, Fibonacci), and native technical overlays.
    *   **Bottom Area (Analysis Tri-Mode):** A tabbed component situated below the chart.
        *   *Mode 1 (Technical Metrics):* Displays calculated technical indicators and standard market values.
        *   *Mode 2 (Live News Feed):* A real-time stream of financial news articles relevant to the current stock, powered by the **Gnews** and **Mediastack** APIs.
        *   *Mode 3 (AI Analysis):* An AI interface (future development) that digests the news feed to provide instant sentiment analysis.
*   **Right Column (Execution & History):**
    *   **Top Area (Trade History):** A real-time scrolling feed of executed trades.
    *   **Bottom Area (Action Center Dual-Mode):** A tabbed component for taking action.
        *   *Mode 1 (Manual Order):* Traditional trading ticket with Buy/Sell buttons.
        *   *Mode 2 (Quick Scripting IDE):* A compact Monaco code editor for adjusting trading scripts on the fly. Includes a prominent "Open in Backtester" button to navigate to the full-screen simulator.

### 2.5. Backtesting Studio (`/backtest`)
A dedicated, full-screen environment for developing and simulating algorithmic strategies.

*   **State Synchronization:** The code editor state (the actual Python script) is synchronized globally using Zustand. Edits made in the Trading Dashboard IDE instantly reflect in the Backtesting Studio IDE, and vice-versa.

*   **Top Bar (Configuration):**
    *   Inputs for selecting the target symbol, date range (e.g., 2020-01-01 to 2024-01-01), timeframe (1D, 1H), and initial capital.
    *   "Run Simulation" and "Deploy Live" action buttons.
*   **Left Pane (The IDE):**
    *   Full-height Monaco code editor for writing Python algorithms.
    *   Integrated AI Copilot chat interface (collapsible) to help generate and debug code.
*   **Right Pane (Results & Analysis):**
    *   *Before Run:* Displays instructions and API documentation for the IDE.
    *   *After Run:* Replaces the documentation with simulation results:
        *   **Equity Curve Chart:** Visualizing portfolio value over time vs benchmark.
        *   **Metrics Panel:** Sharpe Ratio, Max Drawdown, Win Rate, Total P&L.
        *   **Trade Log:** A detailed table of every simulated buy/sell execution.

## 3. UI/UX Technology Stack
*   **Framework:** Next.js (App Router) built as a static export.
*   **Styling:** Tailwind CSS configured with `next-themes` to support three distinct global color palettes: **Day Mode** (bright), **Evening Mode** (warm, low-contrast, soft on eyes), and **Dark Mode** (deep blacks/grays).
*   **Typography:**
    *   *Marketing / Home Page:* **Outfit** (Google Fonts) for a modern, geometric look.
    *   *Primary Application UI:* **Google Sans** for clean, highly legible menus, dashboards, and data tables.
    *   *IDE & Logs:* **JetBrains Mono** for the code editor and raw execution logs.
*   **Component Library:** shadcn/ui (built on Radix UI) for accessible dropdowns, tabs, sidebars, and dialogs.
*   **Charting:** `react-financial-charts` for interactive, open-source financial charting with drawing tools.
*   **Code Editor:** `@monaco-editor/react` for the IDE experience.
