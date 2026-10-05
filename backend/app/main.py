import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.broker.base import BrokerError
from app.broker.ratelimit import Cancelled
from app.config import settings
from app.db import init_db
from app.engine import SCRIP_MASTER_CACHE, engine
from app.market.hub import hub
from app.market.instruments import registry
from app.market.scripmaster import scripmaster
from app.routers import auth, backtests, broker, market, news, scripts, trading
from app.scripts import service as scripts_service
from app.routers import settings as settings_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


class _DropClientResets(logging.Filter):
    """On Windows, asyncio logs a full traceback whenever a browser drops a connection
    (e.g. a cancelled request when clicking quickly between stocks). It's harmless."""

    def filter(self, record: logging.LogRecord) -> bool:
        return not (record.exc_info and isinstance(record.exc_info[1], ConnectionResetError))


logging.getLogger("asyncio").addFilter(_DropClientResets())


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    registry.load()
    # Symbol search runs on Angel One's daily instrument file; fetch it in the background.
    scripmaster.on_update(registry.apply_company_names)
    scripmaster.ensure_fresh(SCRIP_MASTER_CACHE)
    hub.bind_loop(asyncio.get_running_loop())
    scripts_service.start()
    # The engine starts at sign-in, once the credential vault can be decrypted.
    yield
    scripts_service.stop()
    engine.stop()


app = FastAPI(title="QuantVision", version="0.2.0", lifespan=lifespan)

# Reject requests whose Host isn't this machine (defends against DNS rebinding).
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
# Only the Next.js dev server needs CORS; the built UI is served from this origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(BrokerError)
async def broker_error(_: Request, exc: BrokerError) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(Cancelled)
async def cancelled(_: Request, exc: Cancelled) -> JSONResponse:
    # The browser already moved on; nobody reads this response.
    return JSONResponse({"detail": "Request abandoned"}, status_code=499)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "market": hub.status.to_message()}


app.include_router(auth.router)
app.include_router(broker.router)
app.include_router(market.router)
app.include_router(market.ws_router)
app.include_router(trading.router)
app.include_router(scripts.router)
app.include_router(news.router)
app.include_router(backtests.router)
app.include_router(settings_router.router)

# Mounted last so /api and /ws routes take precedence over the static UI.
if settings.frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=settings.frontend_dist, html=True), name="frontend")
