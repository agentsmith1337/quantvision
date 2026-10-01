from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="QuantVision", version="0.1.0")

# Next.js static export output (built with `npm run build` in ../frontend).
FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "out"


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Mounted last so /api routes take precedence over the static UI.
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
