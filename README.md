# quantvision
Local algorithmic trading engine for Angel One. See [`plan/`](plan/) for specs and roadmap.

## Running

Requires Python 3.12+ and Node.js 20+.

```
python run.py            # builds the UI if needed, starts the engine on http://127.0.0.1:8000
python run.py --dev      # hot reload: Next.js on :3000, FastAPI on :8000
python run.py --build    # force a UI rebuild
```

On first launch the browser opens the setup page: create a local account and enter your Angel One
API key, client code, MPIN and TOTP secret. They are encrypted (AES-256-GCM) with a key derived from
your password and only decrypted in memory while you're signed in. Without credentials the engine
streams simulated prices.

Trading starts in **paper mode**: orders fill against live prices with ₹10,00,000 of virtual cash.
Switch to live trading under Settings → Preferences. Angel One only accepts orders from the static
IP registered for your API app; QuantVision checks this before you trade.

App data (SQLite, paper-trading state) lives in `~/Documents/QuantVision` unless `QV_HOME` is set.

## Strategy scripts

Write strategies in Python as an `on_candle(candle, indicators, api)` function, in the
**Backtesting Studio** or the Trading Dashboard's *Script trade* tab. The full reference is on the
in-app **API Docs** page (source: `backend/sdk/sdk_reference.md`).

- Scripts are plain `.py` files in `Documents/QuantVision/scripts/`.
- Each run is a separate Python process in its own environment (`Documents/QuantVision/runtime`,
  created automatically on first launch, about a minute) with pandas and pandas-ta-classic.
  Scripts never receive broker credentials.
- Orders follow the global Paper/Live switch and pass the same risk limits as manual orders, plus a
  per-run limit of 10 orders a minute. The **Kill switch** in the top bar stops every script and
  cancels all open orders.

## News

The Trading Dashboard's *Live news* tab uses [GNews](https://gnews.io). Add your API key under
Settings → News; it's encrypted like your broker credentials. Each stock's news is cached for 30
minutes to stay within the free plan's 100 requests a day.

## Tests

```
cd backend
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest
```
