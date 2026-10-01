from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError

from app import prefs
from app.market.instruments import registry
from app.routers.broker import StaticIps
from app.security import require_session

router = APIRouter(prefix="/api/settings", dependencies=[Depends(require_session)])


class Risk(BaseModel):
    max_order_value: float = Field(gt=0, le=1e9)
    max_orders_per_minute: int = Field(ge=1, le=120)


class Features(BaseModel):
    confirm_orders: bool = True
    execution_popups: bool = True


def _validate(key: str, value: Any) -> Any:
    if key == "watchlist":
        if not isinstance(value, list) or not all(isinstance(s, str) for s in value):
            raise HTTPException(422, "watchlist must be a list of symbols")
        value = list(dict.fromkeys(s.upper() for s in value))
        if unknown := [s for s in value if registry.get(s) is None]:
            raise HTTPException(422, f"Unknown symbols: {', '.join(unknown)}")
        return value
    if key == "trading_mode":
        raise HTTPException(422, "Use PUT /api/broker/mode to switch between paper and live trading")
    models = {"risk": Risk, "static_ips": StaticIps, "features": Features}
    if key not in models:
        raise HTTPException(404, f"No setting {key!r}")
    try:
        return models[key].model_validate(value).model_dump()
    except ValidationError as e:
        raise HTTPException(422, e.errors()[0]["msg"]) from e


@router.get("")
def all_settings() -> dict[str, Any]:
    return prefs.all_prefs()


@router.get("/{key}")
def get_setting(key: str) -> Any:
    if key not in prefs.DEFAULTS:
        raise HTTPException(404, f"No setting {key!r}")
    return prefs.get(key)


@router.put("/{key}")
def put_setting(key: str, value: Annotated[Any, Body()]) -> Any:
    return prefs.put(key, _validate(key, value))
