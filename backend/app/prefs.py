"""Typed access to app preferences stored in the settings table."""

import copy
from typing import Any

from app.db import SessionLocal
from app.market.instruments import DEFAULT_WATCHLIST
from app.models import AppSetting

DEFAULTS: dict[str, Any] = {
    "watchlist": DEFAULT_WATCHLIST,
    # Paper until the user explicitly switches to live trading.
    "trading_mode": "paper",
    "risk": {"max_order_value": 100_000, "max_orders_per_minute": 10},
    "static_ips": {"primary": "", "secondary": ""},
    "features": {"confirm_orders": True, "execution_popups": True},
}


def get(key: str) -> Any:
    with SessionLocal() as db:
        row = db.get(AppSetting, key)
        if row is not None:
            if isinstance(row.value, dict) and isinstance(DEFAULTS.get(key), dict):
                return {**DEFAULTS[key], **row.value}
            return row.value
    return copy.deepcopy(DEFAULTS.get(key))


def all_prefs() -> dict[str, Any]:
    return {k: get(k) for k in DEFAULTS}


def put(key: str, value: Any) -> Any:
    with SessionLocal() as db:
        row = db.get(AppSetting, key)
        if row is None:
            db.add(AppSetting(key=key, value=value))
        else:
            row.value = value
        db.commit()
    return value
