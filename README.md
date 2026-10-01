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

## Tests

```
cd backend
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python -m pytest
```
