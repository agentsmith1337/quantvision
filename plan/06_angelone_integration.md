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

## 7. Algorithmic Script Wrapper
To prevent users from having to manage raw API calls in their trading scripts, we will provide a helper class injected into their script environment:

```python
# Example of what a user's script will look like
def on_tick(ticker, price, api):
    # 'api' is an injected wrapper that handles the actual Angel One calls safely
    if price < 100:
        api.buy(ticker, quantity=10)
```
