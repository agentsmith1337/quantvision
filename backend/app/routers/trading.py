"""Portfolio and order endpoints. They act on the active broker: paper or live."""

from fastapi import APIRouter, Depends
from fastapi.concurrency import run_in_threadpool

from app.broker.base import OrderChanges, OrderRequest
from app.engine import engine
from app.security import require_session

router = APIRouter(prefix="/api", dependencies=[Depends(require_session)])


async def _call(fn, *args):
    # Broker calls block on network I/O (Angel One) or a lock (paper).
    return await run_in_threadpool(fn, *args)


@router.get("/portfolio/holdings")
async def holdings() -> dict:
    broker = engine.broker
    return {"mode": engine.trading_mode, "holdings": [h.to_dict() for h in await _call(broker.holdings)]}


@router.get("/portfolio/positions")
async def positions() -> dict:
    broker = engine.broker
    return {"mode": engine.trading_mode, "positions": [p.to_dict() for p in await _call(broker.positions)]}


@router.get("/portfolio/funds")
async def funds() -> dict:
    broker = engine.broker
    return {"mode": engine.trading_mode, "funds": (await _call(broker.funds)).to_dict()}


@router.get("/orders")
async def orders() -> dict:
    broker = engine.broker
    return {"mode": engine.trading_mode, "orders": [o.to_dict() for o in await _call(broker.orders)]}


@router.get("/orders/trades")
async def trades() -> dict:
    broker = engine.broker
    return {"mode": engine.trading_mode, "trades": [t.to_dict() for t in await _call(broker.trades)]}


@router.post("/orders")
async def place_order(req: OrderRequest) -> dict:
    order = await _call(engine.place_order, req)
    return {"mode": engine.trading_mode, "order": order.to_dict()}


@router.patch("/orders/{order_id}")
async def modify_order(order_id: str, changes: OrderChanges) -> dict:
    order = await _call(engine.modify_order, order_id, changes)
    return {"mode": engine.trading_mode, "order": order.to_dict()}


@router.delete("/orders/{order_id}")
async def cancel_order(order_id: str) -> dict:
    await _call(engine.cancel_order, order_id)
    return {"cancelled": order_id}


@router.post("/orders/cancel-all")
async def cancel_all() -> dict:
    return await _call(engine.cancel_all)
