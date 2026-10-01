from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket
from fastapi.concurrency import run_in_threadpool

from app.market.feeds import FeedUnavailable, MarketFeed
from app.market.hub import hub
from app.market.instruments import BY_SYMBOL, INSTRUMENTS

router = APIRouter()


@router.get("/api/market/instruments")
def list_instruments() -> list[dict]:
    return [i.to_dict() for i in INSTRUMENTS]


@router.get("/api/market/status")
def feed_status() -> dict:
    return hub.status.to_message()


@router.get("/api/market/quote/{symbol}")
def quote(symbol: str) -> dict:
    tick = hub.last_tick(symbol.upper())
    if tick is None:
        raise HTTPException(404, f"No price received yet for {symbol}")
    return tick.to_message()


@router.get("/api/market/candles/{symbol}")
async def candles(
    request: Request,
    symbol: str,
    interval: Literal["1m", "5m", "15m", "1h", "1d"] = "1m",
    days: int = Query(5, ge=1, le=2000),
) -> dict:
    inst = BY_SYMBOL.get(symbol.upper())
    if inst is None:
        raise HTTPException(404, f"Unknown symbol {symbol}")
    feed: MarketFeed = request.app.state.feed
    try:
        bars = await run_in_threadpool(feed.candles, inst, interval, days)
    except FeedUnavailable as e:
        raise HTTPException(503, str(e)) from e
    return {"symbol": inst.symbol, "interval": interval, "candles": bars}


@router.websocket("/ws/market")
async def market_ws(ws: WebSocket) -> None:
    await hub.serve(ws)
