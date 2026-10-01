import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.db import init_db
from app.market.feeds import create_feed
from app.market.hub import hub
from app.routers import market, settings as settings_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    hub.bind_loop(asyncio.get_running_loop())
    feed = create_feed(hub, settings)
    app.state.feed = feed
    feed.start()
    yield
    feed.stop()


app = FastAPI(title="QuantVision", version="0.1.0", lifespan=lifespan)

# Only the Next.js dev server needs CORS; the built UI is served from this origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "market": hub.status.to_message()}


app.include_router(market.router)
app.include_router(settings_router.router)

# Mounted last so /api and /ws routes take precedence over the static UI.
if settings.frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
