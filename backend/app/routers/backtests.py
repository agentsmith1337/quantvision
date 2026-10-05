from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app.backtest import data as data_mod
from app.backtest.manager import MAX_SYMBOLS, BacktestError
from app.scripts import sdk, service
from app.security import require_session

router = APIRouter(prefix="/api/backtests", dependencies=[Depends(require_session)])

CHARGES = sdk.charges


def _err(e: Exception) -> HTTPException:
    if isinstance(e, FileNotFoundError):
        return HTTPException(404, "No such backtest")
    return HTTPException(400, str(e))


@router.get("/config")
def config() -> dict:
    today = data_mod.today_ist()
    return {
        "charges": CHARGES.DEFAULTS,
        "intervals": {iv: {"earliest": (e.isoformat() if (e := data_mod.earliest(iv, today)) else None)} for iv in data_mod.INTERVALS},
        "max_symbols": MAX_SYMBOLS,
        "today": today.isoformat(),
    }


class BacktestRequest(BaseModel):
    script: str = Field(min_length=1, max_length=120)
    symbols: list[str] = Field(min_length=1, max_length=MAX_SYMBOLS)
    interval: str
    start: str
    end: str
    capital: float = 1_000_000
    slippage_pct: float = 0.05
    charges: dict[str, float] = Field(default_factory=dict)


def _overrides(charges: dict[str, float]) -> dict[str, float]:
    """Only the charges that differ from the defaults (the simulation applies them on top of DEFAULTS)."""
    return {k: v for k, v in CHARGES.config(charges).items() if v != CHARGES.DEFAULTS[k]}


@router.post("")
def start(body: BacktestRequest) -> dict:
    try:
        info = service.backtests.start(body.script, body.symbols, body.interval, body.start, body.end, body.capital,
                                       body.slippage_pct, _overrides(body.charges))
    except (BacktestError, data_mod.DataError, FileNotFoundError, ValueError) as e:
        raise _err(e) from e
    return info.to_dict()


@router.get("")
def list_backtests(script: str | None = None) -> list[dict]:
    return service.backtests.list(script)


@router.get("/{backtest_id}")
async def get_backtest(backtest_id: str, logs_after: int = 0) -> dict:
    try:
        return await run_in_threadpool(service.backtests.get, backtest_id, logs_after)
    except (BacktestError, FileNotFoundError) as e:
        raise _err(e) from e


@router.post("/{backtest_id}/cancel")
def cancel(backtest_id: str) -> dict:
    try:
        service.backtests.cancel(backtest_id)
    except BacktestError as e:
        raise _err(e) from e
    return {"ok": True}


@router.delete("/{backtest_id}")
def delete(backtest_id: str) -> dict:
    try:
        service.backtests.delete(backtest_id)
    except (BacktestError, FileNotFoundError) as e:
        raise _err(e) from e
    return {"ok": True}
