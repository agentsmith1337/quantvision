from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket
from fastapi.concurrency import run_in_threadpool

from app.config import is_local_origin
from app.engine import engine
from app.market.feeds import FeedUnavailable
from app.market.hub import hub
from app.market.instruments import registry
from app.security import SESSION_COOKIE, require_session, sessions

router = APIRouter(prefix="/api/market", dependencies=[Depends(require_session)])
ws_router = APIRouter()


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
async def search(q: str = Query(min_length=1, max_length=32)) -> list[dict]:
    return [i.to_dict() for i in await run_in_threadpool(engine.search, q)]


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
        bars = await run_in_threadpool(feed.candles, inst, interval, days)
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
