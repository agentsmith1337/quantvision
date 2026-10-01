import asyncio
import threading
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, WebSocket
from fastapi.concurrency import run_in_threadpool

from app.config import is_local_origin
from app.engine import engine
from app.market.feeds import FeedUnavailable
from app.market.hub import hub
from app.market.instruments import registry
from app.security import SESSION_COOKIE, require_session, sessions

router = APIRouter(prefix="/api/market", dependencies=[Depends(require_session)])
ws_router = APIRouter()


async def run_abortable(request: Request, fn, *args):
    """Run a blocking broker call, signalling it to give up if the browser disconnects.

    Clicking quickly through stocks abandons earlier requests; without this they
    would still queue for Angel One's 1 request/second slots ahead of the new one.
    """
    abort = threading.Event()

    async def watch() -> None:
        while not abort.is_set():
            if await request.is_disconnected():
                abort.set()
                return
            await asyncio.sleep(0.25)

    watcher = asyncio.create_task(watch())
    try:
        return await run_in_threadpool(fn, *args, abort)
    finally:
        abort.set()
        watcher.cancel()


@router.get("/instruments")
def list_instruments() -> list[dict]:
    return [i.to_dict() for i in registry.builtin()]


@router.get("/instruments/{symbol}")
def get_instrument(symbol: str) -> dict:
    inst = registry.get(symbol)
    if inst is None:
        raise HTTPException(404, f"Unknown symbol {symbol}")
    return inst.to_dict()


@router.get("/search")
async def search(request: Request, q: str = Query(min_length=1, max_length=32)) -> list[dict]:
    return [i.to_dict() for i in await run_abortable(request, engine.search, q)]


@router.get("/status")
def feed_status() -> dict:
    return hub.status.to_message()


@router.get("/quote/{symbol}")
def quote(symbol: str) -> dict:
    tick = hub.last_tick(symbol.upper())
    if tick is None:
        raise HTTPException(404, f"No price received yet for {symbol}")
    return tick.to_message()


@router.get("/candles/{symbol}")
async def candles(
    request: Request,
    symbol: str,
    interval: Literal["1m", "5m", "15m", "1h", "1d"] = "1m",
    days: int = Query(5, ge=1, le=2000),
) -> dict:
    inst = registry.get(symbol)
    if inst is None:
        raise HTTPException(404, f"Unknown symbol {symbol}")
    feed = engine.feed
    if feed is None:
        raise HTTPException(409, "Engine is locked; sign in first")
    try:
        bars = await run_abortable(request, feed.candles, inst, interval, days)
    except FeedUnavailable as e:
        raise HTTPException(503, str(e)) from e
    return {"symbol": inst.symbol, "interval": interval, "candles": bars}


@ws_router.websocket("/ws/market")
async def market_ws(ws: WebSocket) -> None:
    # Browsers send Origin on WebSocket handshakes; only our own pages may connect.
    origin = ws.headers.get("origin")
    if (origin is not None and not is_local_origin(origin)) or sessions.get(ws.cookies.get(SESSION_COOKIE)) is None:
        await ws.close(code=1008)
        return
    await hub.serve(ws)
