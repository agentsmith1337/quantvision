# quantvision
Local algorithmic trading engine for Angel One. See [`plan/`](plan/) for specs and roadmap.

## Running

Requires Python 3.12+ and Node.js 20+.

```
python run.py            # builds the UI if needed, starts the engine on http://127.0.0.1:8000
python run.py --dev      # hot reload: Next.js on :3000, FastAPI on :8000
python run.py --build    # force a UI rebuild
```

Market data comes from Angel One when `backend/.env` has credentials (copy `backend/.env.example`);
otherwise the engine streams simulated prices. App data (SQLite) lives in `~/Documents/QuantVision`
unless `QV_HOME` is set.
