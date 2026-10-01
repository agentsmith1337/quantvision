from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_session
from app.market.instruments import BY_SYMBOL, DEFAULT_WATCHLIST
from app.models import AppSetting

router = APIRouter(prefix="/api/settings")

DbSession = Annotated[Session, Depends(get_session)]

DEFAULTS: dict[str, Any] = {
    "watchlist": DEFAULT_WATCHLIST,
}


@router.get("")
def all_settings(db: DbSession) -> dict[str, Any]:
    stored = {s.key: s.value for s in db.query(AppSetting).all()}
    return {**DEFAULTS, **stored}


@router.get("/{key}")
def get_setting(key: str, db: DbSession) -> Any:
    row = db.get(AppSetting, key)
    if row is not None:
        return row.value
    if key in DEFAULTS:
        return DEFAULTS[key]
    raise HTTPException(404, f"No setting {key!r}")


@router.put("/{key}")
def put_setting(key: str, value: Annotated[Any, Body()], db: DbSession) -> Any:
    if key == "watchlist":
        if not isinstance(value, list) or not all(isinstance(s, str) for s in value):
            raise HTTPException(422, "watchlist must be a list of symbols")
        value = [s.upper() for s in value]
        if unknown := [s for s in value if s not in BY_SYMBOL]:
            raise HTTPException(422, f"Unknown symbols: {', '.join(unknown)}")
    row = db.get(AppSetting, key)
    if row is None:
        db.add(AppSetting(key=key, value=value))
    else:
        row.value = value
    db.commit()
    return value
