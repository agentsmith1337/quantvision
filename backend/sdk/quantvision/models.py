"""Plain objects handed to user scripts."""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))


@dataclass(frozen=True)
class Candle:
    symbol: str
    time: datetime  # candle start, IST
    open: float
    high: float
    low: float
    close: float
    volume: int

    @classmethod
    def from_message(cls, symbol: str, d: dict) -> "Candle":
        return cls(
            symbol=symbol,
            time=datetime.fromtimestamp(d["time"], IST),
            open=float(d["open"]),
            high=float(d["high"]),
            low=float(d["low"]),
            close=float(d["close"]),
            volume=int(d.get("volume") or 0),
        )


@dataclass(frozen=True)
class Order:
    order_id: str
    symbol: str
    side: str  # "BUY" / "SELL"
    order_type: str
    product: str
    quantity: int
    filled_quantity: int
    price: float | None
    trigger_price: float | None
    average_price: float | None
    status: str  # "open", "trigger pending", "complete", "rejected", "cancelled", …
    message: str = ""

    @property
    def is_open(self) -> bool:
        return self.status in {"open", "pending", "trigger pending", "open pending", "put order req received", "after market order req received"}

    @property
    def rejected(self) -> bool:
        return self.status == "rejected"

    @classmethod
    def from_message(cls, d: dict) -> "Order":
        return cls(**{k: d.get(k, "" if k == "message" else None) for k in cls.__dataclass_fields__})


@dataclass(frozen=True)
class Funds:
    available_cash: float
    used_margin: float
    net: float
